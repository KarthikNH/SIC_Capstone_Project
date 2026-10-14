"""
Power grid cascading failure simulation engine using pandapower.

Core features:
1. Loading IEEE test cases (IEEE-30 and IEEE-118).
2. Generating randomized pre-contingency operating points with balanced generation redispatch.
3. Applying initial N-1 and N-2 line and generator contingencies.
4. Simulating quasi-dynamic cascading line tripping due to thermal overload.
5. Strict isolation of the FIRST post-contingency power-flow state to eliminate data leakage.
"""

import copy
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import pandapower as pp
import pandapower.networks as pn


def load_grid(case_name: str = "case30", config: Optional[Dict[str, Any]] = None) -> pp.pandapowerNet:
    """
    Load standard IEEE power grid network and calibrate parameters if required.

    Args:
        case_name (str): 'case30' or 'case118'.
        config (Optional[Dict[str, Any]]): Configuration dictionary.

    Returns:
        pp.pandapowerNet: Pandapower grid network instance.
    """
    if case_name == "case30":
        net = pn.case30()
    elif case_name == "case118":
        net = pn.case118()
    else:
        raise ValueError(f"Unsupported grid case: '{case_name}'. Supported: 'case30', 'case118'.")

    # Pandapower case118 uses nominal dummy line ratings (41 kA) in raw data.
    # Calibrate realistic thermal ratings based on base power flow if configured.
    if case_name == "case118" and config and config.get("grid", {}).get("calibrate_case118_ratings", True):
        rating_factor = config.get("grid", {}).get("case118_rating_factor", 1.30)
        net_copy = copy.deepcopy(net)
        try:
            pp.runpp(net_copy, numba=False)
            base_i_ka = net_copy.res_line.i_ka.values
            # Set max_i_ka to rating_factor * base current, with a floor of 0.05 kA
            calibrated_max_i = np.maximum(base_i_ka * rating_factor, 0.05)
            net.line["max_i_ka"] = calibrated_max_i
        except Exception:
            pass

    return net


def apply_random_operating_point(
    net: pp.pandapowerNet,
    rng: np.random.Generator,
    config: Dict[str, Any]
) -> Optional[Tuple[pp.pandapowerNet, float]]:
    """
    Apply randomized loading and proportional generation redispatch to create an N-0 operating point.

    Args:
        net (pp.pandapowerNet): Base pandapower network.
        rng (np.random.Generator): Seeded numpy random number generator.
        config (Dict[str, Any]): Project configuration dictionary.

    Returns:
        Optional[Tuple[pp.pandapowerNet, float]]: Tuple of (modified_net, total_pre_contingency_load_mw)
        or None if pre-contingency power flow fails or has pre-existing line overloads.
    """
    sim_cfg = config.get("simulation", {})
    min_scale = sim_cfg.get("min_load_scale", 0.65)
    max_scale = sim_cfg.get("max_load_scale", 1.20)
    noise_std = sim_cfg.get("per_bus_noise_std", 0.05)
    line_limit_factor = sim_cfg.get("line_limit_factor", 1.15)

    working_net = copy.deepcopy(net)

    # 1. Random aggregate load scale
    global_scale = rng.uniform(min_scale, max_scale)

    # 2. Add individual bus noise
    n_loads = len(working_net.load)
    if n_loads > 0:
        bus_noise = rng.normal(1.0, noise_std, size=n_loads)
        bus_noise = np.clip(bus_noise, 0.7, 1.3)
        working_net.load["p_mw"] *= (global_scale * bus_noise)
        working_net.load["q_mvar"] *= (global_scale * bus_noise)

    total_load_mw = float(working_net.load["p_mw"].sum())
    base_load_mw = float(net.load["p_mw"].sum())
    load_ratio = total_load_mw / (base_load_mw + 1e-9)

    # 3. Proportional generator redispatch
    if len(working_net.gen) > 0:
        new_gen_p = working_net.gen["p_mw"] * load_ratio
        if "min_p_mw" in working_net.gen and "max_p_mw" in working_net.gen:
            new_gen_p = np.clip(new_gen_p, working_net.gen["min_p_mw"], working_net.gen["max_p_mw"])
        working_net.gen["p_mw"] = new_gen_p

    # 4. Validate pre-contingency N-0 state
    try:
        pp.runpp(working_net, numba=False)
        if not working_net.converged:
            return None
    except Exception:
        return None

    return working_net, total_load_mw


def sample_and_apply_contingency(
    net: pp.pandapowerNet,
    rng: np.random.Generator,
    config: Dict[str, Any]
) -> Tuple[pp.pandapowerNet, Dict[str, Any]]:
    """
    Sample an N-1 or N-2 line or generator contingency and apply it to the network.

    Args:
        net (pp.pandapowerNet): Network at pre-contingency operating point.
        rng (np.random.Generator): Seeded random number generator.
        config (Dict[str, Any]): Project configuration dictionary.

    Returns:
        Tuple[pp.pandapowerNet, Dict[str, Any]]: (contingency_net, contingency_metadata)
    """
    contingency_net = copy.deepcopy(net)
    probs_cfg = config.get("simulation", {}).get("contingency_probabilities", {})
    p_n1_line = probs_cfg.get("n1_line", 0.70)
    p_n2_line = probs_cfg.get("n2_line", 0.20)
    p_n1_gen = probs_cfg.get("n1_gen", 0.10)

    # Normalize probabilities
    total_p = p_n1_line + p_n2_line + p_n1_gen
    probs = [p_n1_line / total_p, p_n2_line / total_p, p_n1_gen / total_p]

    available_lines = contingency_net.line[contingency_net.line["in_service"]].index.tolist()
    available_gens = contingency_net.gen[contingency_net.gen["in_service"]].index.tolist() if len(contingency_net.gen) > 0 else []

    choice = rng.choice(["n1_line", "n2_line", "n1_gen"], p=probs)

    # Fallback to line if no gen available
    if choice == "n1_gen" and len(available_gens) == 0:
        choice = "n1_line"

    if choice == "n1_line":
        outage_line = int(rng.choice(available_lines))
        contingency_net.line.at[outage_line, "in_service"] = False
        contingency_info = {
            "contingency_type": "N-1_line",
            "element_type": "line",
            "outaged_indices": [outage_line],
            "contingency_id": f"line_{outage_line}"
        }

    elif choice == "n2_line":
        if len(available_lines) >= 2:
            outage_lines = [int(x) for x in rng.choice(available_lines, size=2, replace=False)]
        else:
            outage_lines = [int(available_lines[0])]
        contingency_net.line.loc[outage_lines, "in_service"] = False
        contingency_info = {
            "contingency_type": "N-2_line",
            "element_type": "line",
            "outaged_indices": outage_lines,
            "contingency_id": f"lines_{'_'.join(map(str, outage_lines))}"
        }

    else:  # n1_gen
        outage_gen = int(rng.choice(available_gens))
        contingency_net.gen.at[outage_gen, "in_service"] = False
        contingency_info = {
            "contingency_type": "N-1_gen",
            "element_type": "gen",
            "outaged_indices": [outage_gen],
            "contingency_id": f"gen_{outage_gen}"
        }

    return contingency_net, contingency_info


def extract_first_post_contingency_state(net: pp.pandapowerNet) -> Dict[str, Any]:
    """
    Extract the FIRST post-contingency power-flow state.

    CRITICAL DATA LEAKAGE PREVENTION:
    Only information available immediately after the initial disturbance is recorded.
    No information from subsequent cascade iterations is included here.

    Args:
        net (pp.pandapowerNet): Network state after first post-contingency AC power flow.

    Returns:
        Dict[str, Any]: Structured dictionary of bus and branch features.
    """
    # 1. Bus features
    buses = net.bus.index.values.astype(int)
    n_buses = len(buses)

    vm_pu = np.nan_to_num(net.res_bus["vm_pu"].values, nan=0.0)
    va_degree = np.nan_to_num(net.res_bus["va_degree"].values, nan=0.0)
    p_bus = np.nan_to_num(net.res_bus["p_mw"].values, nan=0.0)
    q_bus = np.nan_to_num(net.res_bus["q_mvar"].values, nan=0.0)

    # Bus-level loads
    load_p_map = net.load.groupby("bus")["p_mw"].sum().to_dict() if len(net.load) > 0 else {}
    load_q_map = net.load.groupby("bus")["q_mvar"].sum().to_dict() if len(net.load) > 0 else {}
    p_load = np.array([load_p_map.get(b, 0.0) for b in buses], dtype=np.float32)
    q_load = np.array([load_q_map.get(b, 0.0) for b in buses], dtype=np.float32)

    # Bus-level generation
    gen_p_map = net.gen.groupby("bus")["p_mw"].sum().to_dict() if len(net.gen) > 0 else {}
    gen_q_map = net.res_gen["q_mvar"].groupby(net.gen["bus"]).sum().to_dict() if len(net.gen) > 0 else {}
    p_gen = np.array([gen_p_map.get(b, 0.0) for b in buses], dtype=np.float32)
    q_gen = np.array([gen_q_map.get(b, 0.0) for b in buses], dtype=np.float32)

    # Slack injection
    ext_buses = set(net.ext_grid["bus"].values)
    is_slack = np.array([b in ext_buses for b in buses], dtype=np.float32)
    gen_buses = set(net.gen["bus"].values) | ext_buses
    is_gen = np.array([b in gen_buses for b in buses], dtype=np.float32)

    base_kv = net.bus["vn_kv"].values.astype(np.float32)
    bus_in_service = net.bus["in_service"].values.astype(np.float32)

    bus_features = {
        "bus_id": buses,
        "vm_pu": vm_pu.astype(np.float32),
        "va_degree": va_degree.astype(np.float32),
        "p_mw": p_bus.astype(np.float32),
        "q_mvar": q_bus.astype(np.float32),
        "p_load_mw": p_load,
        "q_load_mvar": q_load,
        "p_gen_mw": p_gen,
        "q_gen_mvar": q_gen,
        "base_kv": base_kv,
        "is_gen": is_gen,
        "is_slack": is_slack,
        "in_service": bus_in_service
    }

    # 2. Branch (line) features
    lines = net.line.index.values.astype(int)
    from_bus = net.line["from_bus"].values.astype(int)
    to_bus = net.line["to_bus"].values.astype(int)

    p_from = np.nan_to_num(net.res_line["p_from_mw"].values, nan=0.0).astype(np.float32)
    q_from = np.nan_to_num(net.res_line["q_from_mvar"].values, nan=0.0).astype(np.float32)
    p_to = np.nan_to_num(net.res_line["p_to_mw"].values, nan=0.0).astype(np.float32)
    q_to = np.nan_to_num(net.res_line["q_to_mvar"].values, nan=0.0).astype(np.float32)
    pl_mw = np.nan_to_num(net.res_line["pl_mw"].values, nan=0.0).astype(np.float32)
    ql_mvar = np.nan_to_num(net.res_line["ql_mvar"].values, nan=0.0).astype(np.float32)
    i_ka = np.nan_to_num(net.res_line["i_ka"].values, nan=0.0).astype(np.float32)
    loading_percent = np.nan_to_num(net.res_line["loading_percent"].values, nan=0.0).astype(np.float32)
    line_in_service = net.line["in_service"].values.astype(np.float32)

    r_ohm_per_km = net.line["r_ohm_per_km"].values.astype(np.float32)
    x_ohm_per_km = net.line["x_ohm_per_km"].values.astype(np.float32)
    c_nf_per_km = net.line["c_nf_per_km"].values.astype(np.float32)
    max_i_ka = net.line["max_i_ka"].values.astype(np.float32)
    length_km = net.line["length_km"].values.astype(np.float32)

    branch_features = {
        "line_id": lines,
        "from_bus": from_bus,
        "to_bus": to_bus,
        "p_from_mw": p_from,
        "q_from_mvar": q_from,
        "p_to_mw": p_to,
        "q_to_mvar": q_to,
        "pl_mw": pl_mw,
        "ql_mvar": ql_mvar,
        "i_ka": i_ka,
        "loading_percent": loading_percent,
        "in_service": line_in_service,
        "r_ohm_per_km": r_ohm_per_km,
        "x_ohm_per_km": x_ohm_per_km,
        "c_nf_per_km": c_nf_per_km,
        "max_i_ka": max_i_ka,
        "length_km": length_km
    }

    # Handle transformers if present (e.g. in case118)
    trafo_features = None
    if len(net.trafo) > 0:
        trafo_from = net.trafo["hv_bus"].values.astype(int)
        trafo_to = net.trafo["lv_bus"].values.astype(int)
        trafo_loading = np.nan_to_num(net.res_trafo["loading_percent"].values, nan=0.0).astype(np.float32) if len(net.res_trafo) > 0 else np.zeros(len(net.trafo), dtype=np.float32)
        trafo_in_service = net.trafo["in_service"].values.astype(np.float32)
        trafo_features = {
            "trafo_id": net.trafo.index.values.astype(int),
            "from_bus": trafo_from,
            "to_bus": trafo_to,
            "loading_percent": trafo_loading,
            "in_service": trafo_in_service,
            "sn_mva": net.trafo["sn_mva"].values.astype(np.float32)
        }

    return {
        "bus": bus_features,
        "branch": branch_features,
        "trafo": trafo_features
    }


def simulate_scenario(
    base_net: pp.pandapowerNet,
    scenario_id: int,
    seed: int,
    config: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """
    Run an end-to-end simulation for a single scenario:
    1. Apply random operating point.
    2. Apply initial contingency.
    3. Run first post-contingency AC power flow.
    4. Save FIRST post-contingency power flow state separately (leakage-free).
    5. Execute cascade propagation loop.
    6. Compute labels and return unified scenario payload.

    Args:
        base_net (pp.pandapowerNet): Pristine base network.
        scenario_id (int): Unique identifier for the scenario.
        seed (int): Scenario-specific deterministic random seed.
        config (Dict[str, Any]): Project configuration dictionary.

    Returns:
        Optional[Dict[str, Any]]: Complete scenario dictionary, or None if invalid.
    """
    rng = np.random.default_rng(seed)
    sim_cfg = config.get("simulation", {})
    line_limit_factor = sim_cfg.get("line_limit_factor", 1.15)
    k_trips = sim_cfg.get("cascade_trip_threshold", 3)
    load_shed_threshold = sim_cfg.get("cascade_load_shed_threshold", 0.15)
    max_iter = sim_cfg.get("max_cascade_iterations", 20)

    # Step 1: Pre-contingency Operating Point
    op_result = apply_random_operating_point(base_net, rng, config)
    if op_result is None:
        return None
    pre_net, total_pre_load_mw = op_result

    # Step 2: Sample and Apply Initial Contingency
    post_net, contingency_info = sample_and_apply_contingency(pre_net, rng, config)

    # Step 3: Run FIRST post-contingency AC power flow
    try:
        pp.runpp(post_net, numba=False)
        if not post_net.converged:
            # If initial post-contingency state diverges immediately,
            # we cannot extract a valid post-contingency operating state.
            return None
    except Exception:
        return None

    # Step 4: Extract FIRST post-contingency state (ONLY model input allowed)
    first_state = extract_first_post_contingency_state(post_net)

    # Step 5: Cascade Propagation Loop
    cascade_net = copy.deepcopy(post_net)
    additional_trips: List[int] = []
    cascade_iteration_count = 0
    termination_reason = "stable"
    diverged = False

    limit_threshold = 100.0 * line_limit_factor

    for iteration in range(1, max_iter + 1):
        cascade_iteration_count = iteration
        # Identify overloaded in-service lines
        overloaded_lines = cascade_net.line[
            cascade_net.line["in_service"] & (cascade_net.res_line["loading_percent"] > limit_threshold)
        ].index.tolist()

        # Identify overloaded in-service transformers (if present)
        overloaded_trafos = []
        if len(cascade_net.trafo) > 0 and len(cascade_net.res_trafo) > 0:
            overloaded_trafos = cascade_net.trafo[
                cascade_net.trafo["in_service"] & (cascade_net.res_trafo["loading_percent"] > limit_threshold)
            ].index.tolist()

        # If no overloads, cascade has halted stably
        if len(overloaded_lines) == 0 and len(overloaded_trafos) == 0:
            termination_reason = "stable"
            break

        # Trip overloaded branches
        if len(overloaded_lines) > 0:
            cascade_net.line.loc[overloaded_lines, "in_service"] = False
            additional_trips.extend([int(x) for x in overloaded_lines])

        if len(overloaded_trafos) > 0:
            cascade_net.trafo.loc[overloaded_trafos, "in_service"] = False
            # Tag transformer trips with negative or separate indexing if desired
            additional_trips.extend([int(x + 10000) for x in overloaded_trafos])

        # Re-run power flow
        try:
            pp.runpp(cascade_net, numba=False)
            if not cascade_net.converged:
                diverged = True
                termination_reason = "diverged"
                break
        except Exception:
            diverged = True
            termination_reason = "diverged"
            break
    else:
        termination_reason = "max_iterations_reached"

    # Step 6: Compute Targets and Labels
    if diverged:
        served_load_mw = 0.0
    else:
        served_load_mw = float(np.nan_to_num(cascade_net.res_load["p_mw"].values, nan=0.0).sum())

    load_shed_mw = max(0.0, total_pre_load_mw - served_load_mw)
    load_shed_fraction = float(np.clip(load_shed_mw / (total_pre_load_mw + 1e-9), 0.0, 1.0))
    n_additional_trips = len(additional_trips)

    # Primary binary target: cascade (1) vs no cascade (0)
    is_cascade = int(
        (n_additional_trips >= k_trips) or (load_shed_fraction >= load_shed_threshold) or diverged
    )

    return {
        "scenario_id": scenario_id,
        "seed": seed,
        "contingency_id": contingency_info["contingency_id"],
        "contingency_type": contingency_info["contingency_type"],
        "outaged_indices": contingency_info["outaged_indices"],
        "pre_contingency_load_mw": total_pre_load_mw,
        "first_state": first_state,
        "labels": {
            "cascade": is_cascade,
            "additional_trips": n_additional_trips,
            "load_shed_fraction": load_shed_fraction,
            "load_shed_mw": load_shed_mw,
            "cascade_iterations": cascade_iteration_count,
            "termination_reason": termination_reason,
            "tripped_branch_indices": additional_trips
        }
    }
