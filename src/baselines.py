"""
Classical machine learning baselines and rule-based heuristic for cascading failure prediction.

Baselines:
1. Rule-based heuristic (max post-contingency loading threshold tuned on val).
2. Logistic Regression (L2 regularized, balanced class weights).
3. Random Forest (ensemble trees, balanced class weights).
4. XGBoost (gradient boosted trees, scale_pos_weight).
5. Multi-Layer Perceptron (MLP on flattened tabular features to isolate graph structure benefit).

All models are tuned strictly on the validation set, with recall-favoring operating thresholds.
Runs on both Random Split and Contingency-Held-Out Split.
"""

import os
import sys
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from typing import Any, Dict, List, Tuple
import pickle
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from xgboost import XGBClassifier

from src.evaluate import compute_metrics, find_optimal_threshold, plot_curves
from src.utils.config import load_config
from src.utils.seed import set_seed


class RuleBasedHeuristic:
    """
    Domain heuristic: predicts cascade if max post-contingency line loading exceeds threshold X.
    Threshold X is tuned strictly on the validation set.
    """

    def __init__(self):
        self.threshold_x: float = 100.0

    def fit(self, x_val_max_loading: np.ndarray, y_val: np.ndarray) -> "RuleBasedHeuristic":
        """
        Tune threshold X on the validation set to maximize recall-favoring F2 score.
        """
        candidates = np.linspace(80.0, 140.0, 121)
        best_f2 = -1.0
        best_x = 100.0

        for cand in candidates:
            preds = (x_val_max_loading >= cand).astype(int)
            # F2 calculation
            from sklearn.metrics import fbeta_score
            score = fbeta_score(y_val, preds, beta=2.0, zero_division=0)
            if score > best_f2:
                best_f2 = score
                best_x = float(cand)

        self.threshold_x = best_x
        return self

    def predict_proba(self, x_max_loading: np.ndarray) -> np.ndarray:
        """
        Continuous score representing normalized loading risk via sigmoid scaling.
        """
        # Sigmoid centered around tuned threshold
        scale = 10.0
        prob = 1.0 / (1.0 + np.exp(-(x_max_loading - self.threshold_x) / scale))
        return np.column_stack([1.0 - prob, prob])

    def predict(self, x_max_loading: np.ndarray) -> np.ndarray:
        return (x_max_loading >= self.threshold_x).astype(int)


def tune_and_fit_models(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    feature_names: List[str],
    seed: int = 42
) -> Dict[str, Dict[str, Any]]:
    """
    Train and tune all baselines on validation set.

    Returns:
        Dict mapping model_name -> {'model': trained_model, 'scaler': scaler, 'val_prob': array, 'thresh': float}
    """
    models = {}
    n_neg = int(np.sum(y_train == 0))
    n_pos = int(np.sum(y_train == 1))
    scale_pos = float(n_neg / max(1, n_pos))

    # Standard Scaler for models requiring normalized features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_val_scaled = scaler.transform(X_val)

    # --------------------------------------------------------------------------
    # 1. Rule-Based Heuristic
    # --------------------------------------------------------------------------
    max_load_idx = feature_names.index("max_line_loading")
    x_train_load = X_train[:, max_load_idx]
    x_val_load = X_val[:, max_load_idx]

    heuristic = RuleBasedHeuristic()
    heuristic.fit(x_val_load, y_val)
    val_prob_heur = heuristic.predict_proba(x_val_load)[:, 1]
    th_heur = find_optimal_threshold(y_val, val_prob_heur, beta=2.0)

    models["Rule-Based Heuristic"] = {
        "model": heuristic,
        "scaler": None,
        "is_heuristic": True,
        "max_load_idx": max_load_idx,
        "val_prob": val_prob_heur,
        "thresh": th_heur,
        "best_params": f"Loading Threshold X={heuristic.threshold_x:.1f}%"
    }

    # --------------------------------------------------------------------------
    # 2. Logistic Regression
    # --------------------------------------------------------------------------
    best_lr = None
    best_lr_score = -1.0
    for c in [0.01, 0.1, 1.0, 10.0]:
        lr = LogisticRegression(C=c, class_weight="balanced", max_iter=1000, random_state=seed)
        lr.fit(X_train_scaled, y_train)
        val_p = lr.predict_proba(X_val_scaled)[:, 1]
        score = compute_metrics(y_val, val_p)["pr_auc"]
        if score > best_lr_score:
            best_lr_score = score
            best_lr = lr

    val_prob_lr = best_lr.predict_proba(X_val_scaled)[:, 1]
    th_lr = find_optimal_threshold(y_val, val_prob_lr, beta=2.0)
    models["Logistic Regression"] = {
        "model": best_lr,
        "scaler": scaler,
        "is_heuristic": False,
        "val_prob": val_prob_lr,
        "thresh": th_lr,
        "best_params": f"C={best_lr.C}"
    }

    # --------------------------------------------------------------------------
    # 3. Random Forest
    # --------------------------------------------------------------------------
    best_rf = None
    best_rf_score = -1.0
    for depth in [4, 8, None]:
        for n_est in [100, 200]:
            rf = RandomForestClassifier(
                n_estimators=n_est,
                max_depth=depth,
                min_samples_split=4,
                class_weight="balanced",
                random_state=seed,
                n_jobs=-1
            )
            rf.fit(X_train, y_train)
            val_p = rf.predict_proba(X_val)[:, 1]
            score = compute_metrics(y_val, val_p)["pr_auc"]
            if score > best_rf_score:
                best_rf_score = score
                best_rf = rf

    val_prob_rf = best_rf.predict_proba(X_val)[:, 1]
    th_rf = find_optimal_threshold(y_val, val_prob_rf, beta=2.0)
    models["Random Forest"] = {
        "model": best_rf,
        "scaler": None,
        "is_heuristic": False,
        "val_prob": val_prob_rf,
        "thresh": th_rf,
        "best_params": f"n_est={best_rf.n_estimators}, depth={best_rf.max_depth}"
    }

    # --------------------------------------------------------------------------
    # 4. XGBoost
    # --------------------------------------------------------------------------
    best_xgb = None
    best_xgb_score = -1.0
    for lr_rate in [0.05, 0.1]:
        for depth in [3, 5]:
            xgb = XGBClassifier(
                n_estimators=150,
                max_depth=depth,
                learning_rate=lr_rate,
                scale_pos_weight=scale_pos,
                random_state=seed,
                eval_metric="logloss",
                n_jobs=-1
            )
            xgb.fit(X_train, y_train)
            val_p = xgb.predict_proba(X_val)[:, 1]
            score = compute_metrics(y_val, val_p)["pr_auc"]
            if score > best_xgb_score:
                best_xgb_score = score
                best_xgb = xgb

    val_prob_xgb = best_xgb.predict_proba(X_val)[:, 1]
    th_xgb = find_optimal_threshold(y_val, val_prob_xgb, beta=2.0)
    models["XGBoost"] = {
        "model": best_xgb,
        "scaler": None,
        "is_heuristic": False,
        "val_prob": val_prob_xgb,
        "thresh": th_xgb,
        "best_params": f"lr={best_xgb.learning_rate}, depth={best_xgb.max_depth}"
    }

    # --------------------------------------------------------------------------
    # 5. Multi-Layer Perceptron (MLP)
    # --------------------------------------------------------------------------
    best_mlp = None
    best_mlp_score = -1.0
    for h_layers in [(64, 32), (128, 64)]:
        for alpha in [1e-4, 1e-3]:
            mlp = MLPClassifier(
                hidden_layer_sizes=h_layers,
                alpha=alpha,
                max_iter=400,
                early_stopping=True,
                n_iter_no_change=20,
                random_state=seed
            )
            mlp.fit(X_train_scaled, y_train)
            val_p = mlp.predict_proba(X_val_scaled)[:, 1]
            score = compute_metrics(y_val, val_p)["pr_auc"]
            if score > best_mlp_score:
                best_mlp_score = score
                best_mlp = mlp

    val_prob_mlp = best_mlp.predict_proba(X_val_scaled)[:, 1]
    th_mlp = find_optimal_threshold(y_val, val_prob_mlp, beta=2.0)
    models["MLP (Dense)"] = {
        "model": best_mlp,
        "scaler": scaler,
        "is_heuristic": False,
        "val_prob": val_prob_mlp,
        "thresh": th_mlp,
        "best_params": f"layers={best_mlp.hidden_layer_sizes}, alpha={best_mlp.alpha}"
    }

    return models


def evaluate_on_test(
    models: Dict[str, Dict[str, Any]],
    X_test: np.ndarray,
    y_test: np.ndarray,
    feature_names: List[str]
) -> Tuple[pd.DataFrame, Dict[str, Dict[str, np.ndarray]]]:
    """
    Evaluate fitted models on the test set using validation-selected thresholds.
    """
    rows = []
    test_predictions = {}

    for model_name, info in models.items():
        model = info["model"]
        scaler = info["scaler"]
        th = info["thresh"]

        if info.get("is_heuristic"):
            max_load_idx = info["max_load_idx"]
            x_test_load = X_test[:, max_load_idx]
            y_prob = model.predict_proba(x_test_load)[:, 1]
        elif scaler is not None:
            X_test_scaled = scaler.transform(X_test)
            y_prob = model.predict_proba(X_test_scaled)[:, 1]
        else:
            y_prob = model.predict_proba(X_test)[:, 1]

        metrics = compute_metrics(y_test, y_prob, threshold=th)
        test_predictions[model_name] = {"y_true": y_test, "y_prob": y_prob}

        rows.append({
            "Model": model_name,
            "Accuracy": metrics["accuracy"],
            "Precision": metrics["precision"],
            "Recall": metrics["recall"],
            "F1": metrics["f1"],
            "F2 (Recall-Favored)": metrics["f2"],
            "ROC-AUC": metrics["roc_auc"],
            "PR-AUC": metrics["pr_auc"],
            "False Alarm Rate (FPR)": metrics["false_alarm_rate"],
            "Miss Rate (FNR)": metrics["miss_rate"],
            "Operating Threshold": th,
            "Best Params": info["best_params"]
        })

    return pd.DataFrame(rows), test_predictions


def run_all_baselines(config_path: str = "config.yaml") -> Dict[str, pd.DataFrame]:
    """
    Run baseline benchmark pipeline across both:
    1. Stratified Random Split.
    2. Contingency-Held-Out Split.

    Saves comparison CSV table and ROC/PR curve plots to /results.
    """
    cfg = load_config(config_path)
    seed = cfg.get("project", {}).get("seed", 42)
    set_seed(seed)

    proc_dir = Path(cfg["dataset"].get("processed_data_dir", "data/processed"))
    results_dir = Path("results")
    results_dir.mkdir(parents=True, exist_ok=True)
    (results_dir / "tables").mkdir(parents=True, exist_ok=True)

    # Load tabular data and split indices
    tab_path = proc_dir / cfg["dataset"].get("tabular_features_file", "tabular_features.parquet")
    split_path = proc_dir / cfg["dataset"].get("split_indices_file", "split_indices.pkl")

    df = pd.read_parquet(tab_path)
    with open(split_path, "rb") as f:
        splits = pickle.load(f)

    # Feature columns
    non_feature_cols = [
        "scenario_id", "contingency_id", "contingency_type", "pre_contingency_load_mw",
        "cascade", "additional_trips", "load_shed_fraction", "load_shed_mw",
        "split_random", "split_contingency_held_out", "split_operating_point_held_out"
    ]
    feature_cols = [c for c in df.columns if c not in non_feature_cols]

    X_all = df[feature_cols].values
    y_all = df["cascade"].values

    all_results = {}
    combined_rows = []

    for split_key, split_display in [
        ("random", "Random Split"),
        ("contingency_held_out", "Contingency-Held-Out Split (Unseen Contingencies)")
    ]:
        print(f"\n============================================================")
        print(f"Training Baselines on {split_display}")
        print(f"============================================================")

        sub = splits[split_key]
        train_idx, val_idx, test_idx = sub["train"], sub["val"], sub["test"]

        X_train, y_train = X_all[train_idx], y_all[train_idx]
        X_val, y_val = X_all[val_idx], y_all[val_idx]
        X_test, y_test = X_all[test_idx], y_all[test_idx]

        # Train & Tune
        fitted_models = tune_and_fit_models(X_train, y_train, X_val, y_val, feature_cols, seed=seed)

        # Evaluate on Test
        df_results, test_preds = evaluate_on_test(fitted_models, X_test, y_test, feature_cols)
        df_results.insert(0, "Split", split_display)

        # Plot Curves
        plot_curves(test_preds, save_dir=results_dir, split_name=split_key)

        all_results[split_key] = df_results
        combined_rows.append(df_results)

    # Combined summary table
    df_combined = pd.concat(combined_rows, ignore_index=True)

    # Save to /results/baselines.csv and /results/tables/baselines.csv
    csv_root = results_dir / "baselines.csv"
    csv_tables = results_dir / "tables" / "baselines.csv"
    df_combined.to_csv(csv_root, index=False)
    df_combined.to_csv(csv_tables, index=False)

    print(f"\nSaved benchmark results to {csv_root} and {csv_tables}.")
    return all_results


if __name__ == "__main__":
    run_all_baselines()
