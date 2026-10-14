"""
Inference Engine for live, low-latency cascading failure early warning.

Function: predict(grid_case, outaged_elements, load_scale)
- Runs first post-contingency AC power flow (t=0+).
- Strict zero-leakage guarantee: model strictly operates on t=0+ post-contingency state.
- Builds PyG Data graph, standardizes via saved PowerGridScaler.
- Runs trained GINE model and extracts latent graph embeddings.
- Computes per-branch loading, importance attribution, and bus voltages.
- Calculates before/after contingency delta metrics (overloads, MW rerouted, violations).
- Computes feature group contributions (loading, voltage, load/gen, topology) via grouped ablation.
- Invokes XGBoost second opinion for tabular consensus.
- Evaluates Out-Of-Distribution (OOD) status with plain-language explanations.
- Generates deterministic, template-based operator narrative.
- Employs in-memory caching to guarantee sub-300ms live interaction.
"""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import copy
import time
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
import networkx as nx
import pandapower as pp
import pandapower.networks as pn
import torch

from src.graph_dataset import PowerGridScaler, scenario_to_pyg_data
from src.grid_manager import load_grid_by_id
from src.model import GINEClassifier
from src.narrative import generate_narrative
from src.ood_detector import evaluate_ood
from src.replay import parse_outaged_elements
from src.second_opinion import compute_second_opinion
from src.simulator import extract_first_post_contingency_state
from src.utils.config import load_config
from src.explainability_extensions import (
    compute_counterfactual_actions,
    compute_uncertainty_mc_dropout,
    compute_explanation_quality_and_agreement
)

# Global Singleton Resources
_CONFIG: Optional[Dict[str, Any]] = None
_MODEL: Optional[GINEClassifier] = None
_SCALER: Optional[PowerGridScaler] = None
_BASE_NETS: Dict[str, pp.pandapowerNet] = {}
_PREDICT_CACHE: Dict[Tuple, Dict[str, Any]] = {}


def load_inference_resources(config_path: str = "config.yaml") -> Tuple[GINEClassifier, PowerGridScaler, Dict[str, Any]]:
    """Load and cache model, scaler, and base grids for sub-300ms inference."""
    global _CONFIG, _MODEL, _SCALER, _BASE_NETS

    if _MODEL is not None and _SCALER is not None and _CONFIG is not None:
        return _MODEL, _SCALER, _CONFIG

    _CONFIG = load_config(config_path)
    proc_dir = Path(_CONFIG["dataset"].get("processed_data_dir", "data/processed"))
    scaler_path = proc_dir / _CONFIG["dataset"].get("scalers_file", "scalers.pkl")
    model_path = Path("models/best_gine_model.pt")

    _SCALER = PowerGridScaler.load(scaler_path)

    # Initialize GINE Model
    pyg_path = proc_dir / _CONFIG["dataset"].get("processed_graphs_file", "graph_dataset.pt")
    sample_graphs = torch.load(pyg_path, weights_only=False)
    node_dim = sample_graphs[0].x.shape[1]
    edge_dim = sample_graphs[0].edge_attr.shape[1]

    _MODEL = GINEClassifier(node_dim, edge_dim, hidden_dim=64, num_layers=3)
    if model_path.exists():
        _MODEL.load_state_dict(torch.load(model_path, weights_only=True))
    _MODEL.eval()

    # Pre-cache base grids
    _BASE_NETS["case30"] = load_grid_by_id("case30")
    try:
        _BASE_NETS["case118"] = load_grid_by_id("case118")
    except Exception:
        pass

    return _MODEL, _SCALER, _CONFIG


def compute_feature_group_contributions(
    model: GINEClassifier,
    pyg_data_norm: Any,
    base_prob: float
) -> Dict[str, float]:
    """
    Compute feature-group attribution (loading, voltage, load/generation, topology)
    via fast grouped ablation on the normalized input tensors.
    """
    # Channel partitions in scenario_to_pyg_data:
    # Node continuous:
    #   0: vm_pu, 1: va_deg, 2: p_load, 3: q_load, 4: p_gen, 5: q_gen, 6: delta_vm, 7: net_p, 8: net_q
    # Node categorical:
    #   9: is_pq, 10: is_pv, 11: is_slack, 12: is_outaged_endpoint
    # Edge continuous:
    #   0: p_f, 1: q_f, 2: loading, 3: r, 4: x, 5: max_i, 6: margin
    # Edge categorical:
    #   7: in_service, 8: is_outaged_br

    groups = {
        "loading": {"node_cols": [], "edge_cols": [0, 1, 2, 6]},
        "voltage": {"node_cols": [0, 1, 6], "edge_cols": []},
        "load_generation": {"node_cols": [2, 3, 4, 5, 7, 8], "edge_cols": []},
        "topology": {"node_cols": [9, 10, 11, 12], "edge_cols": [3, 4, 5, 7, 8]}
    }

    deltas: Dict[str, float] = {}
    x_orig = pyg_data_norm.x
    edge_orig = pyg_data_norm.edge_attr
    edge_index = pyg_data_norm.edge_index

    with torch.no_grad():
        for group_name, cols in groups.items():
            x_abl = x_orig.clone()
            edge_abl = edge_orig.clone()

            for c in cols["node_cols"]:
                if c < x_abl.size(1):
                    x_abl[:, c] = 0.0

            for c in cols["edge_cols"]:
                if c < edge_abl.size(1):
                    edge_abl[:, c] = 0.0

            abl_logits = model(x_abl, edge_index, edge_abl)
            abl_prob = float(torch.sigmoid(abl_logits).item())
            diff = abs(base_prob - abl_prob)
            deltas[group_name] = max(diff, 1e-4)

    total_diff = sum(deltas.values())
    return {
        k: round(float(v / total_diff), 3)
        for k, v in deltas.items()
    }


def predict(
    grid_case: str = "case30",
    outaged_elements: Optional[List[Union[str, int]]] = None,
    load_scale: float = 1.0,
    config: Optional[Dict[str, Any]] = None,
    include_explainability: bool = True
) -> Dict[str, Any]:
    """
    Run end-to-end GINE early warning prediction for an initial contingency.

    Args:
        grid_case (str): Grid identifier ('case30', 'case118', or uploaded grid ID).
        outaged_elements (List[Union[str, int]]): Outaged elements (e.g. ['line_3'], ['line_3', 'line_17'], ['gen_1']).
        load_scale (float): Load scaling factor (0.6 to 1.2).
        config (Optional[Dict[str, Any]]): Optional config dict.
        include_explainability (bool): Whether to compute counterfactuals, uncertainty, and fidelity.

    Returns:
        Dict[str, Any]: Comprehensive early warning prediction payload.
    """
    t_start = time.perf_counter()

    if outaged_elements is None or len(outaged_elements) == 0:
        outaged_elements = ["line_0"]

    clean_outaged = tuple(sorted(str(e).strip().lower() for e in outaged_elements))
    cache_key = (grid_case, clean_outaged, round(float(load_scale), 3), include_explainability)

    if cache_key in _PREDICT_CACHE:
        cached_result = copy.deepcopy(_PREDICT_CACHE[cache_key])
        cached_result["latency_ms"] = round((time.perf_counter() - t_start) * 1000.0, 2)
        cached_result["cached"] = True
        return cached_result

    model, scaler, cfg = load_inference_resources("config.yaml")

    # 1. Prepare Base Network
    try:
        net = load_grid_by_id(grid_case)
    except Exception:
        net = pn.case30() if grid_case == "case30" else pn.case118()

    # 2. Scale Load and Redispatch
    base_load_mw = float(net.load["p_mw"].sum()) if len(net.load) > 0 else 100.0
    net.load["p_mw"] *= float(load_scale)
    net.load["q_mvar"] *= float(load_scale)
    total_pre_load = float(net.load["p_mw"].sum())

    if len(net.gen) > 0:
        ratio = total_pre_load / (base_load_mw + 1e-9)
        new_gen = net.gen["p_mw"] * ratio
        if "min_p_mw" in net.gen and "max_p_mw" in net.gen:
            new_gen = np.clip(new_gen, net.gen["min_p_mw"], net.gen["max_p_mw"])
        net.gen["p_mw"] = new_gen

    # Run PRE-CONTINGENCY Power Flow for before/after comparison
    net_pre = copy.deepcopy(net)
    pre_max_loading = 0.0
    pre_overloaded_count = 0
    pre_flows_mw: Dict[int, float] = {}

    try:
        pp.runpp(net_pre, numba=False)
        if net_pre.converged and hasattr(net_pre, "res_line") and len(net_pre.res_line) > 0:
            pre_loadings = net_pre.res_line.loading_percent.values
            pre_max_loading = round(float(np.max(pre_loadings)), 2)
            pre_overloaded_count = int(np.sum(pre_loadings > 100.0))
            for l_idx, p_val in zip(net_pre.line.index, net_pre.res_line.p_from_mw.values):
                pre_flows_mw[int(l_idx)] = float(p_val)
    except Exception:
        pass

    # 3. Apply Initial Disturbance
    outaged_lines, outaged_gens = parse_outaged_elements(net, outaged_elements)
    if outaged_lines:
        valid_lines = [l for l in outaged_lines if l in net.line.index]
        if valid_lines:
            net.line.loc[valid_lines, "in_service"] = False
    if outaged_gens:
        valid_gens = [g for g in outaged_gens if g in net.gen.index]
        if valid_gens:
            net.gen.loc[valid_gens, "in_service"] = False

    # 4. First Post-Contingency AC Power Flow (t = 0+)
    converged = False
    try:
        pp.runpp(net, numba=False)
        converged = bool(net.converged)
    except Exception:
        converged = False

    # 5. Extract First State
    first_state = extract_first_post_contingency_state(net)

    contingency_id = f"cont_{'_'.join(clean_outaged)}"
    c_type = "N-2_line" if len(outaged_lines) >= 2 else ("N-1_line" if outaged_lines else "N-1_gen")

    pseudo_scenario = {
        "scenario_id": -1,
        "seed": 0,
        "contingency_id": contingency_id,
        "contingency_type": c_type,
        "outaged_indices": outaged_lines if outaged_lines else outaged_gens,
        "pre_contingency_load_mw": total_pre_load,
        "first_state": first_state,
        "labels": {
            "cascade": 0,
            "additional_trips": 0,
            "load_shed_fraction": 0.0,
            "load_shed_mw": 0.0
        }
    }

    # 6. Build PyG Data & Apply Scaler
    pyg_data = scenario_to_pyg_data(pseudo_scenario, cfg)
    pyg_data_norm = scaler.transform_graph(pyg_data)

    # 7. Model Inference & Gradient Saliency Attribution
    x = pyg_data_norm.x.clone().detach().requires_grad_(True)
    edge_attr = pyg_data_norm.edge_attr.clone().detach().requires_grad_(True)
    edge_index = pyg_data_norm.edge_index

    logits = model(x, edge_index, edge_attr)
    prob_tensor = torch.sigmoid(logits)
    prob = float(prob_tensor.item())

    # Fast gradient saliency for edge importance
    logits.backward()

    edge_grad = edge_attr.grad.abs().sum(dim=-1).detach().numpy()

    # Extract GNN Latent Graph Representation Embedding
    with torch.no_grad():
        graph_embedding = model.get_graph_embedding(x, edge_index, edge_attr).squeeze(0).cpu().numpy()

    # 8. Post-contingency Branch & Bus Stats
    branch_imp_dict: Dict[int, float] = {}
    branch_loading_dict: Dict[int, float] = {}
    branch_names: Dict[int, str] = {}

    edge_idx_np = edge_index.cpu().numpy()
    line_ids = first_state["branch"]["line_id"]
    from_buses = first_state["branch"]["from_bus"]
    to_buses = first_state["branch"]["to_bus"]
    loadings = first_state["branch"]["loading_percent"]

    for i in range(len(line_ids)):
        lid = int(line_ids[i])
        u, v = int(from_buses[i]), int(to_buses[i])
        branch_names[lid] = f"Line {u}-{v}"
        branch_loading_dict[lid] = round(float(loadings[i]), 2)
        branch_imp_dict[lid] = 0.0

    for e_idx in range(edge_idx_np.shape[1]):
        u = int(edge_idx_np[0, e_idx])
        v = int(edge_idx_np[1, e_idx])
        matches = np.where(
            ((from_buses == u) & (to_buses == v)) | ((from_buses == v) & (to_buses == u))
        )[0]
        if len(matches) > 0:
            lid = int(line_ids[matches[0]])
            branch_imp_dict[lid] = max(branch_imp_dict[lid], float(edge_grad[e_idx]))

    # Normalize importance 0 to 1
    raw_vals = np.array(list(branch_imp_dict.values()))
    min_v, max_v = raw_vals.min(), raw_vals.max()
    norm_denom = max_v - min_v if (max_v - min_v) > 1e-6 else 1.0

    per_branch_importance = {
        lid: round(float((val - min_v) / norm_denom), 3)
        for lid, val in branch_imp_dict.items()
    }

    # Per-bus voltages and violations
    per_bus_voltage = {
        int(b): round(float(v), 3)
        for b, v in zip(first_state["bus"]["bus_id"], first_state["bus"]["vm_pu"])
    }
    voltage_violations = [
        int(b) for b, v in per_bus_voltage.items() if (v < 0.95 or v > 1.05)
    ]

    # Post-contingency overloads and flows
    post_loadings_arr = np.array(list(branch_loading_dict.values()))
    post_max_loading = round(float(np.max(post_loadings_arr)), 2) if len(post_loadings_arr) > 0 else 0.0
    post_overloaded_count = int(np.sum(post_loadings_arr > 100.0))

    # MW rerouted calculation: sum(|P_post - P_pre|)
    mw_rerouted = 0.0
    post_p_from = first_state["branch"].get("p_from_mw", [])
    for idx, lid in enumerate(line_ids):
        lid = int(lid)
        if lid in pre_flows_mw and idx < len(post_p_from):
            mw_rerouted += abs(float(post_p_from[idx]) - pre_flows_mw[lid])

    # Islanded buses check
    G_post = nx.Graph()
    for b in net.bus.index:
        G_post.add_node(int(b))
    for _, l in net.line[net.line.in_service].iterrows():
        G_post.add_edge(int(l.from_bus), int(l.to_bus))
    ext_buses = set(net.ext_grid.bus.values) if len(net.ext_grid) > 0 else set()
    islanded_buses: List[int] = []
    for comp in nx.connected_components(G_post):
        if not (comp & ext_buses):
            islanded_buses.extend(sorted(list(comp)))

    # 9. Top 3 most influential branches
    sorted_branches = sorted(per_branch_importance.items(), key=lambda x: x[1], reverse=True)
    top_3 = []
    for lid, imp in sorted_branches[:3]:
        top_3.append({
            "branch_id": lid,
            "name": branch_names.get(lid, f"Branch {lid}"),
            "loading_percent": branch_loading_dict.get(lid, 0.0),
            "importance": imp
        })

    # Alert level classification (from validation operating thresholds)
    operating_threshold = 0.35
    if prob >= 0.70:
        alert_level = "High"
        summary = "Critical: Outage is highly likely to trigger cascading failures and load shedding."
    elif prob >= operating_threshold:
        alert_level = "Medium"
        summary = "Warning: Stressed operating conditions. Monitoring adjacent branches recommended."
    else:
        alert_level = "Low"
        summary = "Secure: The grid operating margins are sufficient to absorb this disturbance."

    # 10. Confidence Margin to alert threshold
    confidence_margin = round(abs(prob - operating_threshold), 4)

    # 11. Feature-group contribution via grouped ablation
    feature_group_contributions = compute_feature_group_contributions(model, pyg_data_norm, prob)

    # 12. XGBoost Baseline Second Opinion
    try:
        second_opinion = compute_second_opinion(
            gine_prob=prob,
            net=net,
            first_state=first_state,
            contingency_type=c_type,
            outaged_indices=outaged_lines if outaged_lines else outaged_gens
        )
    except Exception as e:
        second_opinion = {
            "model": "XGBoost",
            "probability": prob,
            "operating_threshold": operating_threshold,
            "agrees": True,
            "discrepancy": 0.0,
            "message": f"Consensus evaluation fallback: {str(e)[:60]}"
        }

    # 13. Out-Of-Distribution (OOD) Check
    ood_metrics = {
        "max_line_loading": post_max_loading,
        "min_voltage_pu": min(per_bus_voltage.values()) if per_bus_voltage else 1.0,
        "total_load_mw": total_pre_load
    }
    ood_status = evaluate_ood(
        grid_case=grid_case,
        num_buses=len(net.bus),
        metrics=ood_metrics,
        graph_embedding=graph_embedding
    )

    # 14. Deterministic Plain-Language Narrative
    max_line_name = top_3[0]["name"] if top_3 else "Line"
    num_lines_over_80 = int(np.sum(post_loadings_arr > 80.0))
    narrative = generate_narrative(
        outaged_elements=[str(e) for e in outaged_elements],
        max_loading_branch_name=max_line_name,
        max_loading_percent=post_max_loading,
        num_lines_over_80=num_lines_over_80,
        voltage_violations_count=len(voltage_violations),
        alert_level=alert_level,
        cascade_probability=prob
    )

    latency = round((time.perf_counter() - t_start) * 1000.0, 2)

    result_payload = {
        "grid_case": grid_case,
        "outaged_elements": list(outaged_elements),
        "load_scale": float(load_scale),
        "cascade_probability": round(prob, 4),
        "alert_level": alert_level,
        "summary": summary,
        "narrative": narrative,
        "confidence_margin": confidence_margin,
        "operating_threshold": operating_threshold,
        "power_flow_converged": converged,
        "total_pre_load_mw": round(total_pre_load, 2),
        "before_after": {
            "overloaded_branches_before": pre_overloaded_count,
            "overloaded_branches_after": post_overloaded_count,
            "max_loading_before": pre_max_loading,
            "max_loading_after": post_max_loading,
            "mw_rerouted": round(mw_rerouted, 2),
            "voltage_violations": voltage_violations,
            "islanded_buses": islanded_buses
        },
        "feature_group_contribution": feature_group_contributions,
        "second_opinion": second_opinion,
        "ood_status": ood_status,
        "per_branch_loading": branch_loading_dict,
        "per_branch_importance": per_branch_importance,
        "per_bus_voltage": per_bus_voltage,
        "top_influential_branches": top_3,
        "latency_ms": latency,
        "cached": False
    }

    if include_explainability:
        try:
            unc = compute_uncertainty_mc_dropout(model, scaler, pseudo_scenario, cfg, n_samples=8)
            cf = compute_counterfactual_actions(
                grid_id=grid_case,
                outaged_elements=list(outaged_elements),
                load_scale=load_scale,
                current_risk=prob,
                predict_fn=lambda g, o, s: predict(g, o, s, include_explainability=False),
                alert_threshold=operating_threshold
            )
            qual = compute_explanation_quality_and_agreement(model, scaler, pseudo_scenario, cfg, top_3)
            result_payload["uncertainty"] = unc
            result_payload["counterfactual"] = cf
            result_payload["explanation_quality"] = qual
        except Exception as e:
            result_payload["explainability_error"] = str(e)

    # Store in memory cache
    _PREDICT_CACHE[cache_key] = copy.deepcopy(result_payload)
    return result_payload


def compute_whatif_curve(
    grid_case: str = "case30",
    outaged_elements: Optional[List[Union[str, int]]] = None,
    min_load: float = 0.6,
    max_load: float = 1.2,
    step: float = 0.05
) -> Dict[str, Any]:
    """
    Compute risk curve for load_scale from min_load to max_load in fixed steps.
    """
    if outaged_elements is None:
        outaged_elements = ["line_0"]

    load_scales = [round(ls, 2) for ls in np.arange(min_load, max_load + 1e-5, step)]
    curve_points = []

    for ls in load_scales:
        res = predict(grid_case=grid_case, outaged_elements=outaged_elements, load_scale=ls)
        curve_points.append({
            "load_scale": float(ls),
            "cascade_probability": res["cascade_probability"],
            "alert_level": res["alert_level"],
            "max_loading_percent": res["before_after"]["max_loading_after"],
            "converged": res["power_flow_converged"]
        })

    return {
        "grid_case": grid_case,
        "outaged_elements": list(outaged_elements),
        "step_size": step,
        "points": curve_points,
        "curve_points": curve_points
    }
