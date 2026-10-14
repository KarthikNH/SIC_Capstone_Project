"""
Evaluation metrics, threshold tuning, and visualization tools.
Shared across classical baselines and GNN models.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import matplotlib
matplotlib.use("Agg")  # Non-interactive backend
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    fbeta_score,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)


def compute_metrics(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    threshold: float = 0.5
) -> Dict[str, Any]:
    """
    Compute comprehensive classification metrics for cascading failure prediction.

    Args:
        y_true (np.ndarray): Binary ground truth labels (0 or 1).
        y_prob (np.ndarray): Predicted probability of cascade.
        threshold (float): Decision threshold for binary classification.

    Returns:
        Dict[str, Any]: Dictionary of evaluation metrics.
    """
    y_true = np.asarray(y_true).astype(int)
    y_prob = np.asarray(y_prob).astype(float)
    y_pred = (y_prob >= threshold).astype(int)

    # Confusion matrix elements
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()

    # Rates
    false_alarm_rate = float(fp / (fp + tn)) if (fp + tn) > 0 else 0.0
    miss_rate = float(fn / (fn + tp)) if (fn + tp) > 0 else 0.0

    acc = float(accuracy_score(y_true, y_pred))
    prec = float(precision_score(y_true, y_pred, zero_division=0))
    rec = float(recall_score(y_true, y_pred, zero_division=0))
    f1 = float(f1_score(y_true, y_pred, zero_division=0))
    f2 = float(fbeta_score(y_true, y_pred, beta=2.0, zero_division=0))

    try:
        roc_auc = float(roc_auc_score(y_true, y_prob))
    except Exception:
        roc_auc = 0.5

    try:
        pr_auc = float(average_precision_score(y_true, y_prob))
    except Exception:
        pr_auc = 0.0

    return {
        "accuracy": acc,
        "precision": prec,
        "recall": rec,
        "f1": f1,
        "f2": f2,
        "roc_auc": roc_auc,
        "pr_auc": pr_auc,
        "false_alarm_rate": false_alarm_rate,
        "miss_rate": miss_rate,
        "threshold": float(threshold),
        "tp": int(tp),
        "fp": int(fp),
        "tn": int(tn),
        "fn": int(fn),
        "confusion_matrix": [[int(tn), int(fp)], [int(fn), int(tp)]]
    }


def find_optimal_threshold(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    beta: float = 2.0,
    min_recall: Optional[float] = None
) -> float:
    """
    Find recall-favoring operating threshold on validation data.
    Missing a cascading failure is catastrophic compared to a false alarm,
    so we optimize F_beta (default beta=2 weights recall 4x more than precision).

    Args:
        y_true (np.ndarray): Validation ground truth labels.
        y_prob (np.ndarray): Validation predicted probabilities.
        beta (float): Beta factor for F_beta metric (default 2.0).
        min_recall (Optional[float]): Optional hard minimum recall constraint.

    Returns:
        float: Selected optimal threshold in [0.05, 0.95].
    """
    y_true = np.asarray(y_true).astype(int)
    y_prob = np.asarray(y_prob).astype(float)

    thresholds = np.linspace(0.05, 0.95, 181)
    best_thresh = 0.5
    best_score = -1.0

    for th in thresholds:
        y_pred = (y_prob >= th).astype(int)
        rec = recall_score(y_true, y_pred, zero_division=0)

        if min_recall is not None and rec < min_recall:
            continue

        score = fbeta_score(y_true, y_pred, beta=beta, zero_division=0)
        if score > best_score:
            best_score = score
            best_thresh = float(th)

    return best_thresh


def plot_curves(
    model_predictions: Dict[str, Dict[str, np.ndarray]],
    save_dir: Union[str, Path] = "results",
    split_name: str = "random"
) -> Dict[str, str]:
    """
    Plot and save ROC and Precision-Recall curves comparing multiple models.

    Args:
        model_predictions: Dict mapping model_name -> {'y_true': array, 'y_prob': array}
        save_dir: Output directory path.
        split_name: Name of the split ('random' or 'contingency_held_out').

    Returns:
        Dict[str, str]: Paths to generated plot image files.
    """
    out_dir = Path(save_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    fig_dir = out_dir / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    roc_path = fig_dir / f"roc_curves_{split_name}.png"
    pr_path = fig_dir / f"pr_curves_{split_name}.png"

    # 1. ROC Curves
    plt.figure(figsize=(8, 6), dpi=150)
    for model_name, preds in model_predictions.items():
        y_true = preds["y_true"]
        y_prob = preds["y_prob"]
        try:
            fpr, tpr, _ = roc_curve(y_true, y_prob)
            auc = roc_auc_score(y_true, y_prob)
            plt.plot(fpr, tpr, lw=2, label=f"{model_name} (AUC = {auc:.3f})")
        except Exception:
            continue

    plt.plot([0, 1], [0, 1], color="grey", lw=1.5, linestyle="--", label="Random Chance")
    plt.xlim([0.0, 1.0])
    plt.ylim([0.0, 1.05])
    plt.xlabel("False Alarm Rate (FPR)", fontsize=11, fontweight="bold")
    plt.ylabel("Cascade Detection Rate (True Positive Rate)", fontsize=11, fontweight="bold")
    plt.title(f"ROC Curves - {split_name.replace('_', ' ').title()}", fontsize=13, fontweight="bold")
    plt.legend(loc="lower right", fontsize=9)
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(roc_path)
    plt.close()

    # Also save to root results dir if specified
    plt.figure(figsize=(8, 6), dpi=150)
    for model_name, preds in model_predictions.items():
        y_true = preds["y_true"]
        y_prob = preds["y_prob"]
        try:
            prec, rec, _ = precision_recall_curve(y_true, y_prob)
            pr_auc = average_precision_score(y_true, y_prob)
            plt.plot(rec, prec, lw=2, label=f"{model_name} (PR-AUC = {pr_auc:.3f})")
        except Exception:
            continue

    base_rate = float(np.mean(list(model_predictions.values())[0]["y_true"]))
    plt.plot([0, 1], [base_rate, base_rate], color="grey", lw=1.5, linestyle="--", label=f"No Skill ({base_rate:.2f})")
    plt.xlim([0.0, 1.0])
    plt.ylim([0.0, 1.05])
    plt.xlabel("Recall (1 - Miss Rate)", fontsize=11, fontweight="bold")
    plt.ylabel("Precision", fontsize=11, fontweight="bold")
    plt.title(f"Precision-Recall Curves - {split_name.replace('_', ' ').title()}", fontsize=13, fontweight="bold")
    plt.legend(loc="upper right", fontsize=9)
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(pr_path)
    plt.close()

    # Save direct copies to /results root
    root_roc = out_dir / f"roc_curves_{split_name}.png"
    root_pr = out_dir / f"pr_curves_{split_name}.png"
    import shutil
    shutil.copyfile(roc_path, root_roc)
    shutil.copyfile(pr_path, root_pr)

    return {"roc_curve": str(roc_path), "pr_curve": str(pr_path)}
