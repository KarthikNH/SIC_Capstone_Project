"""
Explainability engine for GINE cascading failure predictions.

Implements:
1. GNNExplainer edge & node importance attribution (normalized 0-1).
2. Explanations for True Positives (TP), False Positives (FP), and False Negatives (FN).
3. Sanity check: Overlap analysis between top-k explained branches vs:
   - Top-k most heavily loaded branches at t=0+
   - Top-k electrically closest branches to the initial disturbance.
4. Visualization export to /results/explanations/.
"""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import json
import pickle
from typing import Any, Dict, List, Optional, Tuple
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch_geometric.data import Data

from src.model import GINEClassifier
from src.utils.config import load_config
from src.utils.seed import set_seed


class GINEExplainer:
    """
    GNN explainability engine computing edge and node attribution scores.
    Combines optimization-based edge masking (GNNExplainer) and gradient saliency.
    """

    def __init__(self, model: GINEClassifier, epochs: int = 100, lr: float = 0.05):
        self.model = model
        self.epochs = epochs
        self.lr = lr
        self.model.eval()

    def explain(
        self,
        data: Data,
        target_class: Optional[int] = None
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Compute normalized edge and node importance scores in [0, 1].

        Args:
            data (Data): Single PyG graph Data instance.
            target_class (Optional[int]): Target class to explain (default is predicted class).

        Returns:
            Tuple[np.ndarray, np.ndarray]: (edge_importance, node_importance)
        """
        device = next(self.model.parameters()).device
        x = data.x.clone().detach().to(device)
        edge_index = data.edge_index.clone().detach().to(device)
        edge_attr = data.edge_attr.clone().detach().to(device) if data.edge_attr is not None else None
        num_edges = edge_index.size(1)
        num_nodes = x.size(0)

        with torch.no_grad():
            orig_logit = self.model(x, edge_index, edge_attr)
            pred_prob = torch.sigmoid(orig_logit).item()
            pred_label = int(pred_prob >= 0.5)

        target = target_class if target_class is not None else pred_label

        # Learnable edge mask parameter initialized near 0.5
        edge_mask = nn.Parameter(torch.randn(num_edges, device=device) * 0.1)
        optimizer = torch.optim.Adam([edge_mask], lr=self.lr)

        # Optimize mutual information: encourage sparsity while maintaining prediction
        for _ in range(self.epochs):
            optimizer.zero_grad()
            m = torch.sigmoid(edge_mask)

            # Apply mask to edge features or edge projection
            if edge_attr is not None:
                masked_edge_attr = edge_attr * m.unsqueeze(-1)
            else:
                masked_edge_attr = None

            logits = self.model(x, edge_index, masked_edge_attr)
            prob = torch.sigmoid(logits)

            # Target matching loss
            if target == 1:
                loss_pred = -torch.log(prob + 1e-8)
            else:
                loss_pred = -torch.log(1.0 - prob + 1e-8)

            # Regularization: L1 sparsity + entropy penalty
            loss_l1 = 0.01 * torch.mean(m)
            loss_ent = -0.005 * torch.mean(m * torch.log(m + 1e-8) + (1.0 - m) * torch.log(1.0 - m + 1e-8))

            loss = loss_pred + loss_l1 + loss_ent
            loss.backward()
            optimizer.step()

        # Extract normalized edge importance
        with torch.no_grad():
            raw_edge_imp = torch.sigmoid(edge_mask).cpu().numpy()

        # Also compute gradient saliency for node importance
        x_grad = data.x.clone().detach().requires_grad_(True)
        logit_grad = self.model(x_grad, edge_index, edge_attr)
        logit_grad.backward()
        raw_node_imp = x_grad.grad.abs().sum(dim=-1).detach().cpu().numpy()

        # Min-max normalization into [0, 1]
        edge_min, edge_max = raw_edge_imp.min(), raw_edge_imp.max()
        edge_norm = (raw_edge_imp - edge_min) / (edge_max - edge_min + 1e-8)

        node_min, node_max = raw_node_imp.min(), raw_node_imp.max()
        node_norm = (raw_node_imp - node_min) / (node_max - node_min + 1e-8)

        return edge_norm, node_norm


def plot_explanation(
    data: Data,
    edge_importance: np.ndarray,
    node_importance: np.ndarray,
    save_path: Union[str, Path],
    title: str = "GINE Explanation Subgraph",
    top_k: int = 5
) -> None:
    """
    Visualize power grid subgraph with branch and bus importance overlays.
    """
    save_path = Path(save_path)
    save_path.parent.mkdir(parents=True, exist_ok=True)

    edge_index = data.edge_index.cpu().numpy()
    num_nodes = data.x.size(0)
    num_edges = edge_index.shape[1]

    G = nx.Graph()
    for i in range(num_nodes):
        G.add_node(i)

    # Average importance for bidirectional pairs
    edge_imp_dict = {}
    for e_idx in range(num_edges):
        u, v = int(edge_index[0, e_idx]), int(edge_index[1, e_idx])
        pair = tuple(sorted((u, v)))
        edge_imp_dict[pair] = max(edge_imp_dict.get(pair, 0.0), float(edge_importance[e_idx]))
        if not G.has_edge(u, v):
            G.add_edge(u, v)

    # Spring layout for reproducible visualization
    pos = nx.spring_layout(G, seed=42)

    plt.figure(figsize=(10, 8), dpi=150)
    plt.title(title, fontsize=13, fontweight="bold", pad=12)

    # Draw nodes sized by node importance
    node_sizes = [200 + 400 * float(node_importance[i]) for i in range(num_nodes)]
    node_colors = [float(node_importance[i]) for i in range(num_nodes)]
    nodes_plot = nx.draw_networkx_nodes(
        G, pos, node_size=node_sizes, node_color=node_colors,
        cmap=plt.cm.viridis, edgecolors="#1d1d1d", linewidths=1.2
    )

    # Draw edges with width and color corresponding to explanation score
    sorted_edges = sorted(G.edges(), key=lambda e: edge_imp_dict.get(e, 0.0))
    edge_weights = [edge_imp_dict.get(e, 0.0) for e in sorted_edges]
    widths = [1.0 + 4.5 * w for w in edge_weights]

    nx.draw_networkx_edges(
        G, pos, edgelist=sorted_edges, width=widths,
        edge_color=edge_weights, edge_cmap=plt.cm.Reds, alpha=0.85
    )

    # Highlight top-k critical branches
    top_branches = sorted(edge_imp_dict.items(), key=lambda x: x[1], reverse=True)[:top_k]
    top_edge_list = [pair for pair, _ in top_branches]
    nx.draw_networkx_edges(
        G, pos, edgelist=top_edge_list, width=4.0,
        edge_color="#c8443b", style="solid"
    )

    # Draw node labels
    nx.draw_networkx_labels(G, pos, font_size=8, font_color="#ffffff", font_weight="bold")

    plt.colorbar(nodes_plot, label="Node Attribution Score", shrink=0.7)
    plt.axis("off")
    plt.tight_layout()
    plt.savefig(save_path)
    plt.close()


def run_sanity_check(
    explainer: GINEExplainer,
    test_graphs: List[Data],
    top_k: int = 5
) -> Dict[str, Any]:
    """
    Sanity check verification:
    Computes overlap between top-k GINE explained branches and:
    1. Top-k most loaded branches at t=0+.
    2. Top-k electrically closest branches to outaged element.

    Returns:
        Dict[str, Any]: Overlap metrics and summary statistics.
    """
    print(f"Running Explainability Sanity Check across {len(test_graphs)} test graphs (top-{top_k} branches)...")
    load_overlaps = []
    proximity_overlaps = []

    for g in test_graphs:
        edge_index = g.edge_index.cpu().numpy()
        edge_imp, _ = explainer.explain(g)

        # Aggregate bidirectional edges
        branch_imp = {}
        branch_loading = {}
        branch_is_outaged = {}

        for e_idx in range(edge_index.shape[1]):
            u, v = int(edge_index[0, e_idx]), int(edge_index[1, e_idx])
            pair = tuple(sorted((u, v)))
            branch_imp[pair] = max(branch_imp.get(pair, 0.0), float(edge_imp[e_idx]))
            # 2nd continuous feature in edge_attr is loading
            loading_val = float(g.edge_attr[e_idx, 2].item()) if g.edge_attr is not None else 0.0
            branch_loading[pair] = max(branch_loading.get(pair, 0.0), loading_val)
            # Last feature is is_outaged_branch
            is_out = float(g.edge_attr[e_idx, -1].item()) if g.edge_attr is not None else 0.0
            if is_out > 0.5:
                branch_is_outaged[pair] = True

        all_branches = list(branch_imp.keys())
        if len(all_branches) < top_k:
            continue

        # Top-k explained
        top_k_explained = set(sorted(all_branches, key=lambda b: branch_imp[b], reverse=True)[:top_k])

        # Top-k loaded
        top_k_loaded = set(sorted(all_branches, key=lambda b: branch_loading[b], reverse=True)[:top_k])

        # Top-k closest to outage (branches sharing a bus with outaged branch)
        outaged_pairs = [b for b, is_o in branch_is_outaged.items() if is_o]
        outaged_buses = set()
        for u, v in outaged_pairs:
            outaged_buses.add(u)
            outaged_buses.add(v)

        def proximity_score(pair):
            score = 0
            if pair in outaged_pairs:
                score += 10
            if pair[0] in outaged_buses:
                score += 2
            if pair[1] in outaged_buses:
                score += 2
            return score

        top_k_closest = set(sorted(all_branches, key=proximity_score, reverse=True)[:top_k])

        # Compute Jaccard / Overlap fractions
        overlap_load = len(top_k_explained.intersection(top_k_loaded)) / top_k
        overlap_prox = len(top_k_explained.intersection(top_k_closest)) / top_k

        load_overlaps.append(overlap_load)
        proximity_overlaps.append(overlap_prox)

    results = {
        "num_evaluated_graphs": len(load_overlaps),
        "top_k": top_k,
        "mean_overlap_with_most_loaded_branches": float(np.mean(load_overlaps)),
        "std_overlap_with_most_loaded_branches": float(np.std(load_overlaps)),
        "mean_overlap_with_electrically_closest_branches": float(np.mean(proximity_overlaps)),
        "std_overlap_with_electrically_closest_branches": float(np.std(proximity_overlaps)),
        "combined_physical_relevance_score": float(np.mean(np.maximum(load_overlaps, proximity_overlaps)))
    }
    return results


def run_full_explainability_pipeline(config_path: str = "config.yaml"):
    """
    Main orchestration routine for Step 5 explainability:
    1. Loads trained model and test graphs.
    2. Generates and plots explanations for TP, FP, and FN examples.
    3. Executes the sanity check overlap test and saves scores to /results/explanations/.
    """
    cfg = load_config(config_path)
    set_seed(cfg.get("project", {}).get("seed", 42))

    proc_dir = Path(cfg["dataset"].get("processed_data_dir", "data/processed"))
    results_dir = Path("results")
    exp_dir = results_dir / "explanations"
    exp_dir.mkdir(parents=True, exist_ok=True)

    pyg_path = proc_dir / cfg["dataset"].get("processed_graphs_file", "graph_dataset.pt")
    split_path = proc_dir / cfg["dataset"].get("split_indices_file", "split_indices.pkl")
    model_path = Path("models/best_gine_model.pt")

    graphs = torch.load(pyg_path, weights_only=False)
    with open(split_path, "rb") as f:
        splits = pickle.load(f)

    # Use Contingency-Held-Out test split
    test_idx = splits["contingency_held_out"]["test"]
    test_graphs = [graphs[i] for i in test_idx]

    # Load Model
    node_dim = graphs[0].x.shape[1]
    edge_dim = graphs[0].edge_attr.shape[1]
    model = GINEClassifier(node_dim, edge_dim, hidden_dim=64, num_layers=3)
    model.load_state_dict(torch.load(model_path, weights_only=True))
    model.eval()

    explainer = GINEExplainer(model, epochs=80, lr=0.08)

    # Find TP, FP, FN instances
    print("Finding representative TP, FP, and FN instances in the test set...")
    with torch.no_grad():
        test_preds = []
        for g in test_graphs:
            prob = model.predict_proba(g.x, g.edge_index, g.edge_attr).item()
            pred = int(prob >= 0.5)
            true = int(g.y.item())
            test_preds.append((true, pred, prob, g))

    tp_candidates = [item for item in test_preds if item[0] == 1 and item[1] == 1]
    fp_candidates = [item for item in test_preds if item[0] == 0 and item[1] == 1]
    fn_candidates = [item for item in test_preds if item[0] == 1 and item[1] == 0]

    examples_to_plot = []
    if tp_candidates:
        examples_to_plot.append(("True_Positive", tp_candidates[0]))
    if fp_candidates:
        examples_to_plot.append(("False_Positive", fp_candidates[0]))
    elif len(test_preds) > 1:
        # Fallback to high-confidence negative if no FP exists
        tn_cand = [item for item in test_preds if item[0] == 0 and item[1] == 0]
        if tn_cand:
            examples_to_plot.append(("True_Negative", tn_cand[0]))
    if fn_candidates:
        examples_to_plot.append(("False_Negative", fn_candidates[0]))

    print(f"Generating explanation plots for {len(examples_to_plot)} representative cases...")
    for label_type, (true, pred, prob, g) in examples_to_plot:
        edge_imp, node_imp = explainer.explain(g, target_class=1)
        plot_path = exp_dir / f"{label_type.lower()}_explanation_sc{g.scenario_id}.png"
        title = (
            f"GINE Explanation - {label_type.replace('_', ' ')} (Scenario {g.scenario_id})\n"
            f"True={true}, Pred={pred} (Prob={prob*100:.1f}%) | Contingency={g.contingency_id}"
        )
        plot_explanation(g, edge_imp, node_imp, plot_path, title=title, top_k=4)
        print(f"  * Saved {label_type} plot to {plot_path}")

    # Run Sanity Check
    sanity_results = run_sanity_check(explainer, test_graphs[:40], top_k=5)
    sanity_json_path = exp_dir / "sanity_check.json"
    with open(sanity_json_path, "w") as f:
        json.dump(sanity_results, f, indent=2)

    df_sanity = pd.DataFrame([sanity_results])
    df_sanity.to_csv(exp_dir / "sanity_check.csv", index=False)
    print(f"\nExplainability Sanity Check Results:")
    print(f"  * Mean Overlap with Top-5 Most Loaded Branches      : {sanity_results['mean_overlap_with_most_loaded_branches']*100:.1f}%")
    print(f"  * Mean Overlap with Top-5 Electrically Closest Lines: {sanity_results['mean_overlap_with_electrically_closest_branches']*100:.1f}%")
    print(f"  * Physical Relevance Score                          : {sanity_results['combined_physical_relevance_score']*100:.1f}%")
    print(f"  * Saved sanity check summary to {sanity_json_path}")

    return sanity_results


if __name__ == "__main__":
    run_full_explainability_pipeline()
