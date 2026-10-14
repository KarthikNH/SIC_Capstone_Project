"""
Cascade Replay Engine.

Simulates ground truth quasi-dynamic cascading failure step-by-step.
CRITICAL LEAKAGE RULE:
This replay output is for VISUALIZATION ONLY and is strictly isolated from model inference.
"""

from typing import Any, Dict, List, Optional, Union
import copy
import numpy as np
import pandapower as pp
import pandapower.networks as pn

from src.utils.config import load_config


def parse_outaged_elements(net: pp.pandapowerNet, outaged_elements: List[Union[str, int]]) -> Tuple[List[int], List[int]]:
    """
    Parse list of outaged element identifiers into line indices and generator indices.
    Supports: "line_3", 3, "gen_1", "3", etc.
    """
    outaged_lines = []
    outaged_gens = []

    for item in outaged_elements:
        item_str = str(item).strip().lower()
        if item_str.startswith("gen_") or item_str.startswith("generator_"):
            idx = int(item_str.split("_")[1])
            if idx in net.gen.index:
                outaged_gens.append(idx)
        elif item_str.startswith("line_") or item_str.startswith("branch_"):
            idx = int(item_str.split("_")[1])
            if idx in net.line.index:
                outaged_lines.append(idx)
        else:
            try:
                idx = int(item_str)
                if idx in net.line.index:
                    outaged_lines.append(idx)
            except ValueError:
                pass

    return outaged_lines, outaged_gens


def simulate_cascade(
    grid_case: str = "case30",
    outaged_elements: Optional[List[Union[str, int]]] = None,
    load_scale: float = 1.0,
    config: Optional[Dict[str, Any]] = None,
    modifications: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Simulate ground truth step-by-step cascading failure propagation for UI visualization.

    Args:
        grid_case (str): 'case30' or 'case118' or uploaded grid ID.
        outaged_elements (List[Union[str, int]]): 1 or 2 outaged elements.
        load_scale (float): Load scaling factor (0.6 to 1.2).
        config (Optional[Dict[str, Any]]): Config dictionary.
        modifications (Optional[Dict[str, Any]]): Operational modifications.

    Returns:
        Dict[str, Any]: Complete step-by-step cascade trajectory for frontend replay.
    """
    if config is None:
        config = load_config("config.yaml")

    if modifications:
        if "load_scale" in modifications:
            load_scale = float(modifications["load_scale"])

    if outaged_elements is None or len(outaged_elements) == 0:
        outaged_elements = ["line_0"]

    try:
        from src.grid_manager import load_grid_by_id
        net = load_grid_by_id(grid_case)
    except Exception:
        if grid_case == "case30":
            net = pn.case30()
        elif grid_case == "case118":
            net = pn.case118()
        else:
            net = pn.case30()

    if grid_case == "case118" and (hasattr(net, "line") and net.line.max_i_ka.max() > 20.0):
        # Calibrate ratings if needed
        rating_factor = config.get("grid", {}).get("case118_rating_factor", 1.30)
        net_copy = copy.deepcopy(net)
        try:
            pp.runpp(net_copy, numba=False)
            net.line["max_i_ka"] = np.maximum(net_copy.res_line.i_ka.values * rating_factor, 0.05)
        except Exception:
            pass

    # Apply any line rating modifications
    if modifications and "line_ratings" in modifications:
        for lid, factor in modifications["line_ratings"].items():
            l_num = int(str(lid).replace("line_", "").replace("branch_", ""))
            if l_num in net.line.index:
                net.line.loc[l_num, "max_i_ka"] *= float(factor)
    if modifications and "line_rating_multiplier" in modifications:
        mult = float(modifications["line_rating_multiplier"])
        net.line["max_i_ka"] *= mult

    sim_cfg = config.get("simulation", {})
    line_limit_factor = sim_cfg.get("line_limit_factor", 1.15)
    limit_threshold = 100.0 * line_limit_factor
    k_trips = int(sim_cfg.get("cascade_trip_threshold", 3))
    load_shed_threshold = float(sim_cfg.get("cascade_load_shed_threshold", 0.15))
    max_steps = int(sim_cfg.get("max_cascade_iterations", 15))

    # 1. Scale Load and Redispatch
    base_load_mw = float(np.nan_to_num(net.load["p_mw"].sum(), nan=100.0))
    net.load["p_mw"] *= float(load_scale)
    net.load["q_mvar"] *= float(load_scale)
    total_pre_load = float(np.nan_to_num(net.load["p_mw"].sum(), nan=100.0))

    if len(net.gen) > 0:
        ratio = total_pre_load / (base_load_mw + 1e-9)
        new_gen = net.gen["p_mw"] * ratio
        if "min_p_mw" in net.gen and "max_p_mw" in net.gen:
            new_gen = np.clip(new_gen, net.gen["min_p_mw"], net.gen["max_p_mw"])
        net.gen["p_mw"] = new_gen

    # Run pre-contingency power flow
    try:
        pp.runpp(net, numba=False)
    except Exception:
        pass

    # 2. Apply Initial Disturbance
    outaged_lines, outaged_gens = parse_outaged_elements(net, outaged_elements)
    if outaged_lines:
        valid_lines = [l for l in outaged_lines if l in net.line.index]
        if valid_lines:
            net.line.loc[valid_lines, "in_service"] = False
    if outaged_gens:
        valid_gens = [g for g in outaged_gens if g in net.gen.index]
        if valid_gens:
            net.gen.loc[valid_gens, "in_service"] = False

    trajectory = []
    all_tripped_branches = list(outaged_lines)
    all_islanded_buses = []

    # Step 0: Immediate post-contingency state (t = 0+)
    converged = False
    try:
        pp.runpp(net, numba=False)
        converged = bool(net.converged)
    except Exception:
        converged = False

    loadings_step0 = {}
    if converged and hasattr(net, "res_line"):
        loadings_step0 = {
            int(idx): round(float(np.nan_to_num(val, nan=0.0)), 2)
            for idx, val in net.res_line["loading_percent"].fillna(0.0).items()
        }
        voltages_step0 = {
            int(idx): round(float(np.nan_to_num(val, nan=1.0)), 3)
            for idx, val in net.res_bus["vm_pu"].fillna(1.0).items()
        }
        served_mw = float(np.nan_to_num(net.res_load["p_mw"].values, nan=0.0).sum())
    else:
        voltages_step0 = {int(b): 0.0 for b in net.bus.index}
        served_mw = 0.0

    load_shed_mw = max(0.0, total_pre_load - served_mw)
    load_shed_frac = min(1.0, max(0.0, load_shed_mw / (total_pre_load + 1e-9)))

    trajectory.append({
        "step": 0,
        "description": f"Initial disturbance applied: {outaged_elements}",
        "caption": f"Initial disturbance applied: {outaged_elements}",
        "newly_tripped_branches": [int(x) for x in outaged_lines],
        "cumulative_tripped_branches": [int(x) for x in all_tripped_branches],
        "cumulative_extra_trips": 0,
        "max_loading_percent": max(loadings_step0.values()) if loadings_step0 else 0.0,
        "branch_loadings": loadings_step0,
        "bus_voltages": voltages_step0,
        "islanded_buses": [],
        "cumulative_isolated_buses": [],
        "load_shed_mw": round(float(load_shed_mw), 2),
        "load_shed_fraction": round(float(load_shed_frac), 4),
        "cumulative_load_shed_mw": round(float(load_shed_mw), 2),
        "cumulative_load_shed_fraction": round(float(load_shed_frac), 4),
        "converged": converged,
        "status": "initial_disturbance"
    })

    # Step 1..K: Cascade Tripping Loop
    step_num = 1
    termination_reason = "stable"

    if converged:
        for step in range(1, max_steps + 1):
            step_num = step
            # Overloaded in-service branches
            res_loadings = net.res_line["loading_percent"].fillna(0.0)
            overloaded = net.line[
                net.line["in_service"] & (res_loadings > limit_threshold)
            ].index.tolist()

            if len(overloaded) == 0:
                termination_reason = "stable"
                break

            # Trip overloaded lines
            net.line.loc[overloaded, "in_service"] = False
            newly_tripped = [int(x) for x in overloaded]
            all_tripped_branches.extend(newly_tripped)

            # Re-run power flow
            try:
                pp.runpp(net, numba=False)
                converged = bool(net.converged)
            except Exception:
                converged = False

            if converged and hasattr(net, "res_line"):
                loadings = {
                    int(idx): round(float(np.nan_to_num(val, nan=0.0)), 2)
                    for idx, val in net.res_line["loading_percent"].fillna(0.0).items()
                }
                voltages = {
                    int(idx): round(float(np.nan_to_num(val, nan=1.0)), 3)
                    for idx, val in net.res_bus["vm_pu"].fillna(1.0).items()
                }
                islanded = [int(idx) for idx, val in net.res_bus["vm_pu"].items() if np.isnan(val)]
                all_islanded_buses = list(set(all_islanded_buses + islanded))
                served_mw = float(np.nan_to_num(net.res_load["p_mw"].values, nan=0.0).sum())
                load_shed_mw = max(0.0, total_pre_load - served_mw)
                load_shed_frac = min(1.0, max(0.0, load_shed_mw / (total_pre_load + 1e-9)))
                status = "tripping"
            else:
                loadings = {}
                voltages = {int(b): 0.0 for b in net.bus.index}
                load_shed_mw = total_pre_load
                load_shed_frac = 1.0
                termination_reason = "diverged"
                status = "voltage_collapse"

            cum_extra = max(0, len(all_tripped_branches) - len(outaged_lines))
            step_desc = f"Cascading step {step}: {len(newly_tripped)} branch(es) tripped due to overload > {limit_threshold:.0f}%"
            trajectory.append({
                "step": step_num,
                "description": step_desc,
                "caption": step_desc,
                "newly_tripped_branches": newly_tripped,
                "cumulative_tripped_branches": [int(x) for x in all_tripped_branches],
                "cumulative_extra_trips": int(cum_extra),
                "max_loading_percent": max(loadings.values()) if loadings else 0.0,
                "branch_loadings": loadings,
                "bus_voltages": voltages,
                "islanded_buses": list(all_islanded_buses),
                "cumulative_isolated_buses": list(all_islanded_buses),
                "load_shed_mw": round(float(load_shed_mw), 2),
                "load_shed_fraction": round(float(load_shed_frac), 4),
                "cumulative_load_shed_mw": round(float(load_shed_mw), 2),
                "cumulative_load_shed_fraction": round(float(load_shed_frac), 4),
                "converged": converged,
                "status": status
            })

            if not converged:
                break
        else:
            termination_reason = "max_iterations_reached"

    # Additional trips beyond the initial disturbance
    additional_trips_count = max(0, len(all_tripped_branches) - len(outaged_lines))

    # Evaluate exact dataset criterion
    trips_fired = additional_trips_count >= k_trips
    shed_fired = load_shed_frac >= load_shed_threshold
    diverged = not converged

    if diverged:
        cascade_criterion = "diverged"
        criterion_explanation = "Counted as a cascade because power flow diverged (voltage collapse / wide-area blackout)."
    elif trips_fired and shed_fired:
        cascade_criterion = "both"
        criterion_explanation = (
            f"Counted as a cascade because {additional_trips_count} extra lines tripped (threshold: >= {k_trips}) "
            f"and load shed reached {load_shed_frac * 100:.1f}% (threshold: >= {load_shed_threshold * 100:.1f}%)."
        )
    elif trips_fired:
        cascade_criterion = "extra_trips"
        criterion_explanation = f"Counted as a cascade because {additional_trips_count} extra lines tripped (threshold: >= {k_trips})."
    elif shed_fired:
        cascade_criterion = "load_shed"
        criterion_explanation = f"Counted as a cascade because load shed reached {load_shed_frac * 100:.1f}% (threshold: >= {load_shed_threshold * 100:.1f}%)."
    else:
        cascade_criterion = "none"
        criterion_explanation = f"Outage contained: {additional_trips_count} extra lines tripped and {load_shed_frac * 100:.1f}% load shed (below cascade thresholds)."

    actual_cascade = bool(diverged or trips_fired or shed_fired)

    return {
        "grid_case": grid_case,
        "grid_id": grid_case,
        "outaged_elements": list(outaged_elements),
        "load_scale": float(load_scale),
        "total_steps": len(trajectory),
        "actual_cascade": actual_cascade,
        "cascade": int(actual_cascade),
        "cascade_criterion": cascade_criterion,
        "criterion_explanation": criterion_explanation,
        "k_extra_trips": k_trips,
        "load_shed_threshold": load_shed_threshold,
        "additional_trips": int(additional_trips_count),
        "final_load_shed_fraction": round(float(load_shed_frac), 4),
        "final_load_shed_mw": round(float(load_shed_mw), 2),
        "final_isolated_buses_count": int(len(all_islanded_buses)),
        "termination_reason": termination_reason,
        "steps": trajectory
    }
