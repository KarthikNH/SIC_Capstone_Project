"""
GINE training, multi-seed evaluation, ablation studies, and final benchmark comparison.

Features:
- Weighted BCE loss addressing cascade class imbalance.
- AdamW optimizer, ReduceLROnPlateau learning rate scheduler.
- Early stopping monitored on validation PR-AUC.
- Multi-seed runs (reporting mean +/- std) on Random Split and Contingency-Held-Out Split.
- Comprehensive ablations:
  * Readout: sum vs mean vs attention pooling.
  * Layer depth: 2 vs 3 vs 4 GINE layers.
  * With vs without edge features (GINE vs node-only GIN).
  * With vs without pre/post delta features.
- Final unified comparison table (GINE vs Heuristic vs LR vs RF vs XGBoost vs MLP).
- Saves best checkpoint to /models/best_gine_model.pt and final plots to /results.
"""

import os
import sys
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import copy
import pickle
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch_geometric.data import Data
from torch_geometric.loader import DataLoader

from src.evaluate import compute_metrics, find_optimal_threshold, plot_curves
from src.model import GINEClassifier
from src.utils.config import load_config
from src.utils.seed import set_seed


def train_epoch(
    model: nn.Module,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    criterion: nn.Module,
    device: torch.device
) -> float:
    """Train model for one epoch."""
    model.train()
    total_loss = 0.0

    for batch in loader:
        batch = batch.to(device)
        optimizer.zero_grad()

        logits = model(batch.x, batch.edge_index, batch.edge_attr, batch.batch)
        y = batch.y.float()

        loss = criterion(logits, y)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=2.0)
        optimizer.step()

        total_loss += float(loss.item()) * batch.num_graphs

    return total_loss / len(loader.dataset)


@torch.no_grad()
def evaluate_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    device: torch.device
) -> Tuple[float, np.ndarray, np.ndarray]:
    """Evaluate model loss and collect predicted probabilities."""
    model.eval()
    total_loss = 0.0
    all_probs = []
    all_targets = []

    for batch in loader:
        batch = batch.to(device)
        logits = model(batch.x, batch.edge_index, batch.edge_attr, batch.batch)
        y = batch.y.float()

        loss = criterion(logits, y)
        total_loss += float(loss.item()) * batch.num_graphs

        probs = torch.sigmoid(logits).cpu().numpy()
        targets = batch.y.cpu().numpy()

        all_probs.append(probs)
        all_targets.append(targets)

    val_loss = total_loss / len(loader.dataset)
    y_prob = np.concatenate(all_probs)
    y_true = np.concatenate(all_targets)

    return val_loss, y_true, y_prob


def train_single_run(
    train_graphs: List[Data],
    val_graphs: List[Data],
    test_graphs: List[Data],
    config: Dict[str, Any],
    seed: int = 42,
    model_override: Optional[Dict[str, Any]] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """
    Train a single GINE run with early stopping on validation PR-AUC.
    """
    set_seed(seed)
    device = torch.device("cpu")

    model_cfg = copy.deepcopy(config.get("model", {}))
    if model_override:
        model_cfg.update(model_override)

    train_cfg = config.get("training", {})
    batch_size = train_cfg.get("batch_size", 32)
    lr = train_cfg.get("lr", 0.001)
    weight_decay = train_cfg.get("weight_decay", 0.0001)
    max_epochs = train_cfg.get("max_epochs", 60)
    patience = train_cfg.get("patience", 15)

    train_loader = DataLoader(train_graphs, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_graphs, batch_size=batch_size, shuffle=False)
    test_loader = DataLoader(test_graphs, batch_size=batch_size, shuffle=False)

    # Class imbalance weighting
    y_train_all = np.array([g.y.item() for g in train_graphs])
    n_neg = int(np.sum(y_train_all == 0))
    n_pos = int(np.sum(y_train_all == 1))
    pos_weight = torch.tensor([n_neg / max(1, n_pos)], dtype=torch.float32, device=device)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    node_dim = train_graphs[0].x.shape[1]
    edge_dim = train_graphs[0].edge_attr.shape[1]

    model = GINEClassifier(
        node_in_dim=node_dim,
        edge_in_dim=edge_dim,
        hidden_dim=model_cfg.get("hidden_dim", 64),
        num_layers=model_cfg.get("num_layers", 3),
        dropout=model_cfg.get("dropout", 0.15),
        readout=model_cfg.get("readout", "sum"),
        use_edge_features=model_cfg.get("use_edge_features", True)
    ).to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", factor=0.5, patience=5, min_lr=1e-5
    )

    best_val_score = -1.0
    best_weights = None
    best_epoch = 0
    patience_counter = 0

    for epoch in range(1, max_epochs + 1):
        tr_loss = train_epoch(model, train_loader, optimizer, criterion, device)
        v_loss, v_true, v_prob = evaluate_epoch(model, val_loader, criterion, device)

        val_metrics = compute_metrics(v_true, v_prob, threshold=0.5)
        val_score = val_metrics["pr_auc"]

        scheduler.step(val_score)

        if val_score > best_val_score:
            best_val_score = val_score
            best_weights = copy.deepcopy(model.state_dict())
            best_epoch = epoch
            patience_counter = 0
        else:
            patience_counter += 1
            if patience_counter >= patience:
                if verbose:
                    print(f"Early stopping at epoch {epoch} (Best epoch: {best_epoch}, Val PR-AUC: {best_val_score:.4f})")
                break

    # Restore best checkpoint
    if best_weights is not None:
        model.load_state_dict(best_weights)

    # Evaluate on Validation set to select recall-favoring operating threshold
    _, val_true, val_prob = evaluate_epoch(model, val_loader, criterion, device)
    opt_threshold = find_optimal_threshold(val_true, val_prob, beta=2.0)

    # Evaluate on Test set using validation threshold
    _, test_true, test_prob = evaluate_epoch(model, test_loader, criterion, device)
    test_metrics = compute_metrics(test_true, test_prob, threshold=opt_threshold)
    val_metrics = compute_metrics(val_true, val_prob, threshold=opt_threshold)

    return {
        "model": model,
        "best_epoch": best_epoch,
        "best_val_pr_auc": best_val_score,
        "opt_threshold": opt_threshold,
        "val_metrics": val_metrics,
        "test_metrics": test_metrics,
        "test_preds": {"y_true": test_true, "y_prob": test_prob}
    }


def run_multiseed_experiments(
    graphs: List[Data],
    splits: Dict[str, Dict[str, np.ndarray]],
    config: Dict[str, Any]
) -> Dict[str, Dict[str, Any]]:
    """
    Run multi-seed training across Random Split and Contingency-Held-Out Split.
    Reports mean and standard deviation across seeds.
    """
    seeds = config.get("training", {}).get("seeds", [42, 43, 44])
    results_by_split = {}
    best_overall_model = None
    best_overall_pr_auc = -1.0

    for split_key in ["random", "contingency_held_out"]:
        sub = splits[split_key]
        train_graphs = [graphs[i] for i in sub["train"]]
        val_graphs = [graphs[i] for i in sub["val"]]
        test_graphs = [graphs[i] for i in sub["test"]]

        seed_results = []
        representative_preds = None

        for s in seeds:
            res = train_single_run(train_graphs, val_graphs, test_graphs, config, seed=s)
            seed_results.append(res["test_metrics"])

            if res["test_metrics"]["pr_auc"] > best_overall_pr_auc:
                best_overall_pr_auc = res["test_metrics"]["pr_auc"]
                best_overall_model = copy.deepcopy(res["model"])

            if representative_preds is None:
                representative_preds = res["test_preds"]

        # Aggregate across seeds
        metrics_keys = [
            "accuracy", "precision", "recall", "f1", "f2",
            "roc_auc", "pr_auc", "false_alarm_rate", "miss_rate", "threshold"
        ]
        agg_mean = {k: float(np.mean([r[k] for r in seed_results])) for k in metrics_keys}
        agg_std = {k: float(np.std([r[k] for r in seed_results])) for k in metrics_keys}

        results_by_split[split_key] = {
            "mean": agg_mean,
            "std": agg_std,
            "individual_runs": seed_results,
            "representative_preds": representative_preds
        }

    # Save best model checkpoint
    models_dir = Path("models")
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / "checkpoints").mkdir(parents=True, exist_ok=True)

    if best_overall_model is not None:
        best_pt = models_dir / "best_gine_model.pt"
        best_ckpt = models_dir / "checkpoints" / "best_gine_model.pt"
        torch.save(best_overall_model.state_dict(), best_pt)
        torch.save(best_overall_model.state_dict(), best_ckpt)
        print(f"Saved best GINE checkpoint (PR-AUC={best_overall_pr_auc:.4f}) to {best_pt}")

    return results_by_split


def run_ablations(
    graphs_with_delta: List[Data],
    splits: Dict[str, Dict[str, np.ndarray]],
    config: Dict[str, Any]
) -> pd.DataFrame:
    """
    Perform systematic ablation studies on the Contingency-Held-Out Split:
    1. Readout: sum vs mean vs attention
    2. Layers: 2 vs 3 vs 4
    3. Edge features: with vs without
    4. Pre/post delta features: with vs without
    """
    print("\n============================================================")
    print("Running GINE Systematic Ablations (Contingency-Held-Out Split)")
    print("============================================================")

    sub = splits["contingency_held_out"]
    train_idx, val_idx, test_idx = sub["train"], sub["val"], sub["test"]

    ablation_configs = [
        # Baseline reference GINE (3 layers, sum readout, with edge & delta)
        ("GINE (Default Reference: 3 Layers, Sum, With Edge & Delta)", {}, False),
        # Readout ablations
        ("Readout Ablation: Mean Pooling", {"readout": "mean"}, False),
        ("Readout Ablation: Attention Pooling", {"readout": "attention"}, False),
        # Layer depth ablations
        ("Layer Depth Ablation: 2 GINE Layers", {"num_layers": 2}, False),
        ("Layer Depth Ablation: 4 GINE Layers", {"num_layers": 4}, False),
        # Edge feature ablation (GIN vs GINE)
        ("Edge Feature Ablation: Without Edge Features (Node-Only GIN)", {"use_edge_features": False}, False),
        # Delta features ablation
        ("Delta Feature Ablation: Without Delta Features", {}, True),
    ]

    # Pre-build graph dataset without delta features
    raw_pkl = Path(config["dataset"].get("raw_data_dir", "data/raw")) / config["dataset"].get("raw_backup_pickle", "scenarios_raw.pkl")
    with open(raw_pkl, "rb") as f:
        scenarios = pickle.load(f)

    from src.graph_dataset import build_pyg_dataset, PowerGridScaler
    cfg_no_delta = copy.deepcopy(config)
    cfg_no_delta["dataset"]["include_delta_features"] = False
    graphs_no_delta = build_pyg_dataset(scenarios, cfg_no_delta)
    scaler_no_delta = PowerGridScaler(graphs_no_delta[0].continuous_node_dim, graphs_no_delta[0].continuous_edge_dim)
    scaler_no_delta.fit([graphs_no_delta[i] for i in train_idx])
    graphs_no_delta = scaler_no_delta.transform_list(graphs_no_delta)

    rows = []

    for name, override, use_no_delta_graphs in ablation_configs:
        current_graphs = graphs_no_delta if use_no_delta_graphs else graphs_with_delta
        tr_g = [current_graphs[i] for i in train_idx]
        v_g = [current_graphs[i] for i in val_idx]
        te_g = [current_graphs[i] for i in test_idx]

        res = train_single_run(tr_g, v_g, te_g, config, seed=42, model_override=override)
        m = res["test_metrics"]

        rows.append({
            "Ablation Experiment": name,
            "Accuracy": m["accuracy"],
            "Precision": m["precision"],
            "Recall": m["recall"],
            "F1": m["f1"],
            "F2 (Recall-Favored)": m["f2"],
            "ROC-AUC": m["roc_auc"],
            "PR-AUC": m["pr_auc"],
            "False Alarm Rate (FPR)": m["false_alarm_rate"],
            "Miss Rate (FNR)": m["miss_rate"],
            "Operating Threshold": res["opt_threshold"]
        })
        print(f"  * {name:<65} | PR-AUC: {m['pr_auc']:.4f} | F1: {m['f1']:.4f} | FPR: {m['false_alarm_rate']:.4f}")

    df_ablations = pd.DataFrame(rows)
    out_dir = Path("results")
    df_ablations.to_csv(out_dir / "ablations.csv", index=False)
    df_ablations.to_csv(out_dir / "tables" / "ablations.csv", index=False)
    print(f"Saved ablations table to {out_dir / 'ablations.csv'}")

    return df_ablations


def generate_final_comparison_and_plots(
    gine_multiseed_results: Dict[str, Dict[str, Any]],
    config: Dict[str, Any]
) -> pd.DataFrame:
    """
    Merge classical baselines from results/baselines.csv with GINE results.
    Update ROC and PR plots.
    """
    results_dir = Path("results")
    baselines_csv = results_dir / "baselines.csv"

    df_base = pd.read_csv(baselines_csv) if baselines_csv.exists() else pd.DataFrame()

    gine_rows = []
    for split_key, split_display in [
        ("random", "Random Split"),
        ("contingency_held_out", "Contingency-Held-Out Split (Unseen Contingencies)")
    ]:
        res = gine_multiseed_results[split_key]
        m = res["mean"]
        s = res["std"]

        gine_rows.append({
            "Split": split_display,
            "Model": "GINE (Graph Neural Network)",
            "Accuracy": f"{m['accuracy']:.4f} +/- {s['accuracy']:.4f}",
            "Precision": f"{m['precision']:.4f} +/- {s['precision']:.4f}",
            "Recall": f"{m['recall']:.4f} +/- {s['recall']:.4f}",
            "F1": f"{m['f1']:.4f} +/- {s['f1']:.4f}",
            "F2 (Recall-Favored)": f"{m['f2']:.4f} +/- {s['f2']:.4f}",
            "ROC-AUC": f"{m['roc_auc']:.4f} +/- {s['roc_auc']:.4f}",
            "PR-AUC": f"{m['pr_auc']:.4f} +/- {s['pr_auc']:.4f}",
            "False Alarm Rate (FPR)": f"{m['false_alarm_rate']:.4f} +/- {s['false_alarm_rate']:.4f}",
            "Miss Rate (FNR)": f"{m['miss_rate']:.4f} +/- {s['miss_rate']:.4f}",
            "Operating Threshold": f"{m['threshold']:.3f}",
            "Best Params": f"3 Layers, Sum Readout, Edge+Delta Features (mean of 3 seeds)"
        })

    df_gine = pd.DataFrame(gine_rows)

    # Format baseline metrics to match string format
    formatted_base_rows = []
    for _, row in df_base.iterrows():
        r = dict(row)
        for col in ["Accuracy", "Precision", "Recall", "F1", "F2 (Recall-Favored)", "ROC-AUC", "PR-AUC", "False Alarm Rate (FPR)", "Miss Rate (FNR)"]:
            if isinstance(r.get(col), (int, float)):
                r[col] = f"{r[col]:.4f}"
        if "Operating Threshold" in r and isinstance(r["Operating Threshold"], (int, float)):
            r["Operating Threshold"] = f"{r['Operating Threshold']:.3f}"
        formatted_base_rows.append(r)

    df_base_formatted = pd.DataFrame(formatted_base_rows)

    # Combine into final table
    df_final = pd.concat([df_base_formatted, df_gine], ignore_index=True)
    # Sort so GINE appears alongside baselines cleanly per split
    df_final = df_final.sort_values(by=["Split", "Model"]).reset_index(drop=True)

    final_csv = results_dir / "final_comparison.csv"
    final_tables_csv = results_dir / "tables" / "final_comparison.csv"
    df_final.to_csv(final_csv, index=False)
    df_final.to_csv(final_tables_csv, index=False)
    print(f"Saved final comparison table to {final_csv}")

    # Update plots with GINE included
    from src.baselines import tune_and_fit_models, evaluate_on_test
    tab_df = pd.read_parquet(Path(config["dataset"]["processed_data_dir"]) / config["dataset"]["tabular_features_file"])
    with open(Path(config["dataset"]["processed_data_dir"]) / config["dataset"]["split_indices_file"], "rb") as f:
        splits = pickle.load(f)

    non_feat = [
        "scenario_id", "contingency_id", "contingency_type", "pre_contingency_load_mw",
        "cascade", "additional_trips", "load_shed_fraction", "load_shed_mw",
        "split_random", "split_contingency_held_out", "split_operating_point_held_out"
    ]
    feat_cols = [c for c in tab_df.columns if c not in non_feat]
    X_all = tab_df[feat_cols].values
    y_all = tab_df["cascade"].values

    for split_key in ["random", "contingency_held_out"]:
        sub = splits[split_key]
        fitted = tune_and_fit_models(
            X_all[sub["train"]], y_all[sub["train"]],
            X_all[sub["val"]], y_all[sub["val"]],
            feat_cols, seed=42
        )
        _, test_preds = evaluate_on_test(fitted, X_all[sub["test"]], y_all[sub["test"]], feat_cols)

        # Add GINE representative predictions
        gine_preds = gine_multiseed_results[split_key]["representative_preds"]
        test_preds["GINE (Ours)"] = gine_preds

        plot_curves(test_preds, save_dir=results_dir, split_name=split_key)

    return df_final


def main(config_path: str = "config.yaml"):
    """Main training orchestration."""
    cfg = load_config(config_path)
    proc_dir = Path(cfg["dataset"].get("processed_data_dir", "data/processed"))

    pyg_path = proc_dir / cfg["dataset"].get("processed_graphs_file", "graph_dataset.pt")
    split_path = proc_dir / cfg["dataset"].get("split_indices_file", "split_indices.pkl")

    graphs = torch.load(pyg_path, weights_only=False)
    with open(split_path, "rb") as f:
        splits = pickle.load(f)

    print("============================================================")
    print(f"Loaded {len(graphs)} PyG Graphs. Training GINE Across Multiple Seeds...")
    print("============================================================")

    # 1. Multi-seed training
    multiseed_res = run_multiseed_experiments(graphs, splits, cfg)

    # 2. Ablations
    run_ablations(graphs, splits, cfg)

    # 3. Final Comparison Table and Updated Curves
    df_final = generate_final_comparison_and_plots(multiseed_res, cfg)

    print("\n============================================================")
    print("STEP 4 EXECUTION COMPLETE")
    print("============================================================")


if __name__ == "__main__":
    main()
