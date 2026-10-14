"""
XGBoost Baseline Second Opinion Engine.

Trains and evaluates a calibrated XGBoost tabular baseline on the 21 domain-engineered
power system features extracted from the first post-contingency state (t=0+).
Zero data leakage: operates strictly on the post-contingency power flow solution.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
import networkx as nx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = PROJECT_ROOT / "models" / "xgboost_baseline.json"

_XGB_MODEL: Optional[XGBClassifier] = None
_FEATURE_COLS: List[str] = [
    "max_line_loading", "mean_line_loading", "std_line_loading",
    "n_lines_over_80", "n_lines_over_90", "n_lines_over_100", "n_lines_over_110",
    "min_voltage_pu", "max_voltage_pu", "mean_voltage_pu", "std_voltage_pu",
    "n_buses_under_095", "n_buses_over_105",
    "total_load_mw", "total_gen_mw", "net_power_balance_mw",
    "failed_element_degree_mean", "failed_element_betweenness_mean",
    "is_line_contingency", "is_gen_contingency", "is_n2_contingency"
]


def train_or_load_xgboost_model() -> XGBClassifier:
    """Load cached XGBoost model or train and save if not present."""
    global _XGB_MODEL
    if _XGB_MODEL is not None:
        return _XGB_MODEL

    if MODEL_PATH.exists():
        model = XGBClassifier()
        model.load_model(str(MODEL_PATH))
        _XGB_MODEL = model
        return _XGB_MODEL

    # Train on training split
    tab_path = PROJECT_ROOT / "data" / "processed" / "tabular_features.parquet"
    split_path = PROJECT_ROOT / "data" / "processed" / "split_indices.pkl"

    df = pd.read_parquet(tab_path)
    import pickle
    with open(split_path, "rb") as f:
        splits = pickle.load(f)

    train_idx = splits.get("random", {}).get("train", np.arange(len(df)))

    X_train = df.loc[train_idx, _FEATURE_COLS].values
    y_train = df.loc[train_idx, "cascade"].values

    n_neg = int(np.sum(y_train == 0))
    n_pos = int(np.sum(y_train == 1))
    scale_pos = float(n_neg / max(1, n_pos))

    model = XGBClassifier(
        n_estimators=150,
        max_depth=4,
        learning_rate=0.08,
        scale_pos_weight=scale_pos,
        random_state=42,
        eval_metric="logloss"
    )
    model.fit(X_train, y_train)

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    model.save_model(str(MODEL_PATH))
    _XGB_MODEL = model
    return _XGB_MODEL


def extract_tabular_features_from_first_state(
    net: Any,
    first_state: Dict[str, Any],
    contingency_type: str,
    outaged_indices: List[int]
) -> pd.DataFrame:
    """Extract the 21 tabular features from the first post-contingency state."""
    bus_d = first_state["bus"]
    br_d = first_state["branch"]

    vm = np.array(bus_d["vm_pu"], dtype=float)
    v_min = float(np.min(vm)) if len(vm) > 0 else 1.0
    v_max = float(np.max(vm)) if len(vm) > 0 else 1.0
    v_mean = float(np.mean(vm)) if len(vm) > 0 else 1.0
    v_std = float(np.std(vm)) if len(vm) > 0 else 0.0
    n_buses_under_095 = int(np.sum(vm < 0.95))
    n_buses_over_105 = int(np.sum(vm > 1.05))

    loadings = np.array(br_d["loading_percent"], dtype=float)
    load_max = float(np.max(loadings)) if len(loadings) > 0 else 0.0
    load_mean = float(np.mean(loadings)) if len(loadings) > 0 else 0.0
    load_std = float(np.std(loadings)) if len(loadings) > 0 else 0.0
    n_lines_over_80 = int(np.sum(loadings > 80.0))
    n_lines_over_90 = int(np.sum(loadings > 90.0))
    n_lines_over_100 = int(np.sum(loadings > 100.0))
    n_lines_over_110 = int(np.sum(loadings > 110.0))

    tot_load = float(np.sum(bus_d["p_load_mw"]))
    tot_gen = float(np.sum(bus_d["p_gen_mw"]))

    is_line = 1.0 if "line" in contingency_type else 0.0
    is_gen = 1.0 if "gen" in contingency_type else 0.0
    is_n2 = 1.0 if "N-2" in contingency_type else 0.0

    # Graph degree & betweenness
    G = nx.Graph()
    for b in net.bus.index:
        G.add_node(int(b))
    for _, l in net.line.iterrows():
        G.add_edge(int(l.from_bus), int(l.to_bus))

    deg = dict(G.degree())
    try:
        betw = nx.betweenness_centrality(G)
    except Exception:
        betw = {b: 0.0 for b in G.nodes()}

    elem_deg = []
    elem_betw = []
    if is_line:
        for idx in outaged_indices:
            matches = np.where(br_d["line_id"] == idx)[0]
            for m in matches:
                u, v = int(br_d["from_bus"][m]), int(br_d["to_bus"][m])
                elem_deg.extend([deg.get(u, 0), deg.get(v, 0)])
                elem_betw.extend([betw.get(u, 0.0), betw.get(v, 0.0)])
    else:
        for idx in outaged_indices:
            if idx in net.gen.index:
                gb = int(net.gen.loc[idx, "bus"])
                elem_deg.append(deg.get(gb, 0))
                elem_betw.append(betw.get(gb, 0.0))

    failed_deg_mean = float(np.mean(elem_deg)) if elem_deg else 2.0
    failed_betw_mean = float(np.mean(elem_betw)) if elem_betw else 0.05

    row = {
        "max_line_loading": load_max,
        "mean_line_loading": load_mean,
        "std_line_loading": load_std,
        "n_lines_over_80": n_lines_over_80,
        "n_lines_over_90": n_lines_over_90,
        "n_lines_over_100": n_lines_over_100,
        "n_lines_over_110": n_lines_over_110,
        "min_voltage_pu": v_min,
        "max_voltage_pu": v_max,
        "mean_voltage_pu": v_mean,
        "std_voltage_pu": v_std,
        "n_buses_under_095": n_buses_under_095,
        "n_buses_over_105": n_buses_over_105,
        "total_load_mw": tot_load,
        "total_gen_mw": tot_gen,
        "net_power_balance_mw": tot_gen - tot_load,
        "failed_element_degree_mean": failed_deg_mean,
        "failed_element_betweenness_mean": failed_betw_mean,
        "is_line_contingency": is_line,
        "is_gen_contingency": is_gen,
        "is_n2_contingency": is_n2,
    }

    return pd.DataFrame([row])


def compute_second_opinion(
    gine_prob: float,
    net: Any,
    first_state: Dict[str, Any],
    contingency_type: str,
    outaged_indices: List[int]
) -> Dict[str, Any]:
    """Compute XGBoost baseline probability and consensus check."""
    model = train_or_load_xgboost_model()
    df_feat = extract_tabular_features_from_first_state(net, first_state, contingency_type, outaged_indices)
    xgb_prob = float(model.predict_proba(df_feat[_FEATURE_COLS].values)[0, 1])

    threshold = 0.35
    gine_alert = gine_prob >= threshold
    xgb_alert = xgb_prob >= threshold
    agrees = (gine_alert == xgb_alert)
    discrepancy = round(abs(gine_prob - xgb_prob), 4)

    if agrees:
        if gine_alert:
            msg = "Both GINE and XGBoost concur on elevated cascading failure risk."
        else:
            msg = "Both GINE and XGBoost concur that operating margins are currently stable."
    else:
        if gine_prob > xgb_prob:
            msg = "GINE flags structural topological stress not captured by tabular aggregations."
        else:
            msg = "XGBoost flags tabular loading stress higher than GNN topological prediction."

    return {
        "model": "XGBoost",
        "probability": round(xgb_prob, 4),
        "operating_threshold": threshold,
        "agrees": bool(agrees),
        "discrepancy": discrepancy,
        "message": msg
    }
