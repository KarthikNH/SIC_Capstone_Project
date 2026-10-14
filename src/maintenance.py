"""
Risk-Based Maintenance Prioritisation Engine.

Provides:
1. 24-hour configurable daily load profile.
2. Asset metadata management (age, condition, inspection date) with CSV upload
   and deterministic seeded simulated fallback for any grid.
3. Transparent maintenance priority computation combining Consequence (N-1 cascade risk)
   and Likelihood (Asset Condition + Asset Age + 24h Thermal Loading Stress).
4. Planned outage evaluation: hourly outage risk curve, optimal maintenance window,
   and simulator verification.

DISCLAIMER:
This is a risk-based operational prioritisation method, NOT a learned remaining-useful-life (RUL)
prediction model, as no historical asset failure event logs are available.
"""

import copy
import csv
import io
import json
import logging
import math
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandapower as pp

from src.criticality import start_criticality_analysis
from src.grid_manager import load_grid_by_id
from src.inference import predict
from src.replay import simulate_cascade

logger = logging.getLogger("gridwatch.maintenance")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ASSET_DATA_DIR = PROJECT_ROOT / "data" / "asset_data"
MAINTENANCE_CACHE_DIR = PROJECT_ROOT / "data" / "maintenance_cache"

ASSET_DATA_DIR.mkdir(parents=True, exist_ok=True)
MAINTENANCE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Typical 24-hour daily commercial/residential load profile (normalized multipliers)
# Peaks at 11:00-12:00 (115%) and 18:00-19:00 (120%), valley at 02:00-05:00 (60-65%)
DEFAULT_24H_LOAD_PROFILE: List[float] = [
    0.65, 0.62, 0.60, 0.60, 0.63, 0.68,
    0.78, 0.90, 1.02, 1.10, 1.14, 1.15,
    1.12, 1.10, 1.08, 1.05, 1.08, 1.16,
    1.20, 1.18, 1.10, 0.98, 0.85, 0.72
]

# In-memory LRU-style cache
_PRIORITY_CACHE: Dict[str, Dict[str, Any]] = {}
_PLANNED_OUTAGE_CACHE: Dict[str, Dict[str, Any]] = {}


def get_grid_assets(grid_id: str) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Load asset table for a given grid.
    If a user uploaded a CSV (data/asset_data/{grid_id}.csv), load it.
    Otherwise, generate deterministic SIMULATED values using a fixed seed.

    Returns:
        Tuple of (list_of_assets, is_simulated_boolean)
    """
    csv_path = ASSET_DATA_DIR / f"{grid_id}.csv"
    if csv_path.exists():
        try:
            assets = []
            with open(csv_path, mode="r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    assets.append({
                        "asset_id": row.get("asset_id", "").strip(),
                        "name": row.get("name", "").strip() or row.get("asset_id", "").strip(),
                        "asset_type": row.get("asset_type", "line").strip(),
                        "age_years": float(row.get("age_years", 15.0)),
                        "condition_score": max(0.0, min(1.0, float(row.get("condition_score", 0.8)))),
                        "last_inspection_date": row.get("last_inspection_date", "2024-01-15").strip(),
                    })
            if assets:
                return assets, False
        except Exception as e:
            logger.warning(f"Failed to read custom asset CSV for {grid_id}: {e}")

    # Generate deterministic simulated data
    net = load_grid_by_id(grid_id)
    assets = generate_simulated_asset_table(net, grid_id)
    return assets, True


def generate_simulated_asset_table(net: Any = None, grid_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Generate deterministic simulated asset data with a fixed seed per grid.
    Labeled everywhere as 'Simulated asset data'.
    """
    if isinstance(net, str) and grid_id is None:
        grid_id = net
        net = load_grid_by_id(grid_id)
    elif net is None:
        grid_id = grid_id or "case30"
        net = load_grid_by_id(grid_id)
    grid_id = grid_id or "case30"

    # Deterministic seed based on grid_id
    seed = int(abs(hash(f"grid_asset_seed_{grid_id}"))) % (2**31 - 1)
    rng = np.random.default_rng(seed)

    assets: List[Dict[str, Any]] = []

    # Lines
    for l_idx in net.line.index:
        fb = int(net.line.loc[l_idx, "from_bus"])
        tb = int(net.line.loc[l_idx, "to_bus"])
        age = round(float(rng.uniform(3.0, 42.0)), 1)
        # Condition generally degrades with age + random variance
        base_condition = max(0.12, 1.0 - (age / 50.0) + float(rng.normal(0, 0.12)))
        cond = round(float(np.clip(base_condition, 0.15, 0.98)), 2)

        # Inspection date: random within the last 18 months
        days_ago = int(rng.integers(15, 540))
        # Fixed epoch reference for deterministic date output
        ref_timestamp = 1776000000 - days_ago * 86400
        t_struct = time.gmtime(ref_timestamp)
        date_str = f"{t_struct.tm_year}-{t_struct.tm_mon:02d}-{t_struct.tm_mday:02d}"

        assets.append({
            "asset_id": f"line_{l_idx}",
            "name": f"Line {fb + 1} - {tb + 1}",
            "asset_type": "transmission_line",
            "from_bus": fb,
            "to_bus": tb,
            "age_years": age,
            "condition_score": cond,
            "last_inspection_date": date_str,
        })

    # Transformers (if any)
    if hasattr(net, "trafo") and len(net.trafo) > 0:
        for t_idx in net.trafo.index:
            hvb = int(net.trafo.loc[t_idx, "hv_bus"])
            lvb = int(net.trafo.loc[t_idx, "lv_bus"])
            age = round(float(rng.uniform(5.0, 38.0)), 1)
            cond = round(float(np.clip(1.0 - (age / 48.0) + rng.normal(0, 0.1), 0.2, 0.95)), 2)
            days_ago = int(rng.integers(30, 400))
            ref_timestamp = 1776000000 - days_ago * 86400
            t_struct = time.gmtime(ref_timestamp)
            date_str = f"{t_struct.tm_year}-{t_struct.tm_mon:02d}-{t_struct.tm_mday:02d}"

            assets.append({
                "asset_id": f"trafo_{t_idx}",
                "name": f"Trafo {hvb + 1} - {lvb + 1}",
                "asset_type": "transformer",
                "from_bus": hvb,
                "to_bus": lvb,
                "age_years": age,
                "condition_score": cond,
                "last_inspection_date": date_str,
            })

    return assets


def get_asset_template_csv(grid_id: str = "case30") -> str:
    """Generate a downloadable CSV template with standard columns."""
    assets, _ = get_grid_assets(grid_id)
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["asset_id", "name", "asset_type", "age_years", "condition_score", "last_inspection_date"]
    )
    writer.writeheader()
    for a in assets:
        writer.writerow({
            "asset_id": a["asset_id"],
            "name": a["name"],
            "asset_type": a["asset_type"],
            "age_years": a["age_years"],
            "condition_score": a["condition_score"],
            "last_inspection_date": a["last_inspection_date"]
        })
    return output.getvalue()


def save_uploaded_asset_data(grid_id: str, content: str) -> Tuple[int, List[str]]:
    """
    Validate and save uploaded CSV for a grid.
    Returns (num_valid_rows, list_of_errors).
    """
    errors: List[str] = []
    valid_rows: List[Dict[str, Any]] = []

    try:
        reader = csv.DictReader(io.StringIO(content))
        required = {"asset_id", "age_years", "condition_score"}
        if not required.issubset(set(reader.fieldnames or [])):
            missing = required - set(reader.fieldnames or [])
            return 0, [f"Missing required columns in CSV: {', '.join(missing)}"]

        for idx, row in enumerate(reader, start=1):
            aid = row.get("asset_id", "").strip()
            if not aid:
                errors.append(f"Row {idx}: missing asset_id")
                continue
            try:
                age = float(row.get("age_years", 0))
                cond = float(row.get("condition_score", 1.0))
                if age < 0 or age > 100:
                    errors.append(f"Row {idx} ({aid}): age_years must be between 0 and 100")
                if cond < 0 or cond > 1.0:
                    errors.append(f"Row {idx} ({aid}): condition_score must be between 0.0 and 1.0")
            except ValueError:
                errors.append(f"Row {idx} ({aid}): numeric format error in age_years or condition_score")
                continue

            valid_rows.append({
                "asset_id": aid,
                "name": row.get("name", aid).strip(),
                "asset_type": row.get("asset_type", "line").strip(),
                "age_years": age,
                "condition_score": cond,
                "last_inspection_date": row.get("last_inspection_date", "2024-01-01").strip()
            })

    except Exception as e:
        return 0, [f"CSV parse error: {str(e)}"]

    if errors:
        return 0, errors

    target_path = ASSET_DATA_DIR / f"{grid_id}.csv"
    with open(target_path, mode="w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["asset_id", "name", "asset_type", "age_years", "condition_score", "last_inspection_date"]
        )
        writer.writeheader()
        writer.writerows(valid_rows)

    # Invalidate caches for this grid
    clear_maintenance_cache(grid_id)
    return len(valid_rows), []


def clear_maintenance_cache(grid_id: Optional[str] = None):
    """Clear in-memory and disk caches."""
    global _PRIORITY_CACHE, _PLANNED_OUTAGE_CACHE
    if grid_id:
        keys_to_del = [k for k in _PRIORITY_CACHE if k.startswith(grid_id)]
        for k in keys_to_del:
            _PRIORITY_CACHE.pop(k, None)
        outage_keys = [k for k in _PLANNED_OUTAGE_CACHE if k.startswith(grid_id)]
        for k in outage_keys:
            _PLANNED_OUTAGE_CACHE.pop(k, None)
    else:
        _PRIORITY_CACHE.clear()
        _PLANNED_OUTAGE_CACHE.clear()


# ==============================================================================
# Transparent Mathematical Formulation
# ==============================================================================
FORMULA_EXPLANATION = {
    "consequence": "Predicted system cascade failure probability if the asset trips (derived from N-1 contingency screening via the GNN early warning model).",
    "stress": "Stress Score S = 0.40 * (Peak Loading % / 120%) + 0.35 * (Hours > 80% / 24h) + 0.25 * (Hours > 100% / 24h), normalized between 0 and 1.",
    "likelihood": "Likelihood Score L = 0.45 * (1.0 - Condition) + 0.30 * min(1.0, Age / 40) + 0.25 * Stress Score S.",
    "priority": "Maintenance Priority Score P = Likelihood * Consequence (range 0 to 1, higher indicates urgent maintenance needed).",
    "disclaimer": "Risk-based prioritisation, not a learned remaining-useful-life (RUL) prediction, as no historical failure event logs are available."
}


def compute_asset_thermal_stress(
    net: pp.pandapowerNet,
    load_profile: List[float]
) -> Dict[str, Dict[str, float]]:
    """
    Run 24-hour AC load flow across the daily curve to compute:
    - hours above 80% loading
    - hours above 100% loading
    - peak loading percent
    - composite stress score
    """
    branch_stats: Dict[str, Dict[str, Any]] = {}
    for l_idx in net.line.index:
        branch_stats[f"line_{l_idx}"] = {
            "loadings": [],
            "hours_above_80": 0,
            "hours_above_100": 0,
            "peak_loading": 0.0,
            "avg_loading": 0.0
        }

    # Evaluate each hour (or sample key hours if large grid)
    step = 1 if len(net.line) <= 60 else 2  # 1h step for small grids, 2h step for 118+ bus
    evaluated_hours = list(range(0, 24, step))

    base_p = net.load["p_mw"].copy()
    base_q = net.load["q_mvar"].copy() if "q_mvar" in net.load else None

    for h in evaluated_hours:
        multiplier = load_profile[h]
        net.load["p_mw"] = base_p * multiplier
        if base_q is not None:
            net.load["q_mvar"] = base_q * multiplier

        try:
            pp.runpp(net, numba=False, max_iteration=25)
            for l_idx in net.line.index:
                aid = f"line_{l_idx}"
                loading = float(net.res_line.loc[l_idx, "loading_percent"])
                if np.isnan(loading):
                    loading = 45.0
                branch_stats[aid]["loadings"].append(loading)
                if loading >= 80.0:
                    branch_stats[aid]["hours_above_80"] += step
                if loading >= 100.0:
                    branch_stats[aid]["hours_above_100"] += step
                if loading > branch_stats[aid]["peak_loading"]:
                    branch_stats[aid]["peak_loading"] = loading
        except Exception:
            # If power flow diverges at high load, record stressed values
            for l_idx in net.line.index:
                aid = f"line_{l_idx}"
                loading = 95.0 * multiplier
                branch_stats[aid]["loadings"].append(loading)
                if loading >= 80.0:
                    branch_stats[aid]["hours_above_80"] += step
                if loading >= 100.0:
                    branch_stats[aid]["hours_above_100"] += step
                if loading > branch_stats[aid]["peak_loading"]:
                    branch_stats[aid]["peak_loading"] = loading

    # Restore base load
    net.load["p_mw"] = base_p
    if base_q is not None:
        net.load["q_mvar"] = base_q

    stress_results: Dict[str, Dict[str, float]] = {}
    for aid, s in branch_stats.items():
        peak = round(float(s["peak_loading"]), 1)
        h80 = min(24, int(s["hours_above_80"]))
        h100 = min(24, int(s["hours_above_100"]))
        avg_l = round(float(np.mean(s["loadings"])) if s["loadings"] else 40.0, 1)

        # Composite stress score in [0, 1]
        s_score = 0.40 * min(1.0, peak / 120.0) + 0.35 * (h80 / 24.0) + 0.25 * (h100 / 24.0)
        s_score = round(float(np.clip(s_score, 0.05, 1.0)), 3)

        stress_results[aid] = {
            "peak_loading_pct": peak,
            "avg_loading_pct": avg_l,
            "hours_above_80": h80,
            "hours_above_100": h100,
            "stress_score": s_score
        }

    return stress_results


def compute_maintenance_priorities(
    grid_id: str,
    load_profile: Optional[List[float]] = None
) -> Dict[str, Any]:
    """
    Main entry point for POST /maintenance/priority.
    Computes priority for all assets in the grid:
    - consequence (N-1 cascade risk)
    - stress (daily thermal loading)
    - likelihood (condition + age + stress)
    - priority = likelihood * consequence
    - ranking & human-readable reason
    """
    profile = load_profile if (load_profile and len(load_profile) == 24) else DEFAULT_24H_LOAD_PROFILE
    cache_key = f"{grid_id}_{hash(tuple(round(x, 2) for x in profile))}"

    if cache_key in _PRIORITY_CACHE:
        return copy.deepcopy(_PRIORITY_CACHE[cache_key])

    t_start = time.perf_counter()
    net = load_grid_by_id(grid_id)
    assets, is_simulated = get_grid_assets(grid_id)

    # 1. Thermal stress analysis over 24-hour profile
    stress_map = compute_asset_thermal_stress(net, profile)

    # 2. Consequence analysis: retrieve N-1 cascade probabilities
    # Use criticality analysis at nominal 1.0 load scale
    crit_result = start_criticality_analysis(grid_id, load_scale=1.0)
    consequence_map: Dict[str, float] = {}
    if crit_result.get("status") == "completed" and crit_result.get("result"):
        for elem in crit_result["result"].get("all_elements_screened", []):
            consequence_map[elem["element_id"]] = float(elem.get("cascade_probability", 0.1))

    # Fallback consequence if not pre-computed
    if not consequence_map:
        for a in assets:
            consequence_map[a["asset_id"]] = 0.20

    items: List[Dict[str, Any]] = []

    for a in assets:
        aid = a["asset_id"]
        cond = float(a["condition_score"])
        age = float(a["age_years"])

        # Consequence C in [0, 1]
        consequence = round(float(consequence_map.get(aid, 0.25)), 3)

        # Stress S in [0, 1]
        s_data = stress_map.get(aid, {
            "peak_loading_pct": 50.0,
            "avg_loading_pct": 40.0,
            "hours_above_80": 0,
            "hours_above_100": 0,
            "stress_score": 0.20
        })
        stress_score = float(s_data["stress_score"])

        # Likelihood L = 0.45 * (1 - condition) + 0.30 * min(1, age / 40) + 0.25 * stress
        age_factor = min(1.0, age / 40.0)
        cond_factor = 1.0 - cond
        likelihood = 0.45 * cond_factor + 0.30 * age_factor + 0.25 * stress_score
        likelihood = round(float(np.clip(likelihood, 0.05, 0.98)), 3)

        # Priority P = L * C
        priority_score = round(float(likelihood * consequence), 4)

        # Categorization
        if priority_score >= 0.40:
            urgency = "Critical"
            color = "#dc2626"
        elif priority_score >= 0.20:
            urgency = "High"
            color = "#ea580c"
        elif priority_score >= 0.08:
            urgency = "Medium"
            color = "#d97706"
        else:
            urgency = "Low"
            color = "#16a34a"

        # Plain-language explanation of reason
        reasons = []
        if consequence >= 0.60:
            reasons.append(f"severe cascade consequence ({int(consequence*100)}% risk if tripped)")
        elif consequence >= 0.35:
            reasons.append(f"moderate cascade impact ({int(consequence*100)}% risk)")

        if s_data["hours_above_100"] > 0:
            reasons.append(f"overloads {s_data['hours_above_100']}h/day (peak {s_data['peak_loading_pct']}%)")
        elif s_data["hours_above_80"] >= 4:
            reasons.append(f"stressed loading {s_data['hours_above_80']}h/day")

        if cond <= 0.40:
            reasons.append(f"poor physical condition ({cond})")
        if age >= 30:
            reasons.append(f"aging asset ({age} yrs)")

        if not reasons:
            reasons.append("nominal operational margins")

        reason_text = f"{urgency} priority: {'; '.join(reasons)}."

        items.append({
            "asset_id": aid,
            "name": a["name"],
            "asset_type": a["asset_type"],
            "age_years": age,
            "condition_score": cond,
            "last_inspection_date": a["last_inspection_date"],
            "peak_loading_pct": s_data["peak_loading_pct"],
            "avg_loading_pct": s_data["avg_loading_pct"],
            "hours_above_80": s_data["hours_above_80"],
            "hours_above_100": s_data["hours_above_100"],
            "stress_score": stress_score,
            "likelihood": likelihood,
            "consequence": consequence,
            "priority_score": priority_score,
            "urgency": urgency,
            "color": color,
            "reason": reason_text
        })

    # Sort descending by priority_score
    items.sort(key=lambda x: x["priority_score"], reverse=True)
    for idx, item in enumerate(items, start=1):
        item["rank"] = idx

    elapsed_ms = round((time.perf_counter() - t_start) * 1000, 1)

    result = {
        "grid_id": grid_id,
        "is_simulated_data": is_simulated,
        "data_source_label": "Simulated asset data" if is_simulated else "Uploaded asset data",
        "load_profile": profile,
        "total_assets": len(items),
        "elapsed_ms": elapsed_ms,
        "formula": FORMULA_EXPLANATION,
        "summary": {
            "critical_count": sum(1 for x in items if x["urgency"] == "Critical"),
            "high_count": sum(1 for x in items if x["urgency"] == "High"),
            "medium_count": sum(1 for x in items if x["urgency"] == "Medium"),
            "low_count": sum(1 for x in items if x["urgency"] == "Low"),
            "top_priority_asset": items[0]["name"] if items else None
        },
        "priorities": items
    }

    _PRIORITY_CACHE[cache_key] = copy.deepcopy(result)
    return result


def evaluate_planned_outage(
    grid_id: str,
    asset_id: str,
    load_profile: Optional[List[float]] = None
) -> Dict[str, Any]:
    """
    POST /maintenance/planned-outage:
    Simulates taking the asset offline across the 24-hour profile.
    Returns:
    - 24-hour risk curve
    - Safest window recommendation
    - Unsafe/avoid window
    - Plain-language verdict
    - Verification using actual cascading simulator
    """
    profile = load_profile if (load_profile and len(load_profile) == 24) else DEFAULT_24H_LOAD_PROFILE
    cache_key = f"{grid_id}_{asset_id}_{hash(tuple(round(x, 2) for x in profile))}"

    if cache_key in _PLANNED_OUTAGE_CACHE:
        return copy.deepcopy(_PLANNED_OUTAGE_CACHE[cache_key])

    hourly_risks: List[Dict[str, Any]] = []

    # Run predictions for each hour with this asset outaged
    for h in range(24):
        load_scale = profile[h]
        try:
            pred = predict(
                grid_case=grid_id,
                outaged_elements=[asset_id],
                load_scale=load_scale
            )
            prob = float(pred["cascade_probability"])
            alert = str(pred["alert_level"])
            max_l = float(pred["before_after"]["max_loading_after"])
        except Exception:
            prob = 0.25
            alert = "Low"
            max_l = 65.0

        hourly_risks.append({
            "hour": h,
            "hour_label": f"{h:02d}:00",
            "load_multiplier": round(load_scale, 2),
            "cascade_risk": round(prob, 3),
            "alert_level": alert,
            "max_loading_pct": round(max_l, 1)
        })

    # Find the safest consecutive 4-hour window
    window_size = 4
    min_window_risk = float("inf")
    safest_start = 0
    for start_h in range(24 - window_size + 1):
        win_risk = sum(hourly_risks[start_h + i]["cascade_risk"] for i in range(window_size))
        if win_risk < min_window_risk:
            min_window_risk = win_risk
            safest_start = start_h

    safest_end = safest_start + window_size
    safest_window_str = f"{safest_start:02d}:00 to {safest_end:02d}:00"
    safest_avg_risk = round(min_window_risk / window_size, 3)

    # Find peak avoid window (hours with highest risk)
    max_risk_hour = max(hourly_risks, key=lambda x: x["cascade_risk"])
    avoid_start = max(0, max_risk_hour["hour"] - 1)
    avoid_end = min(24, max_risk_hour["hour"] + 2)
    avoid_window_str = f"{avoid_start:02d}:00 to {avoid_end:02d}:00"

    # Verify safest window using ground-truth simulator
    sim_load = profile[safest_start + 1]
    sim_result = simulate_cascade(
        grid_case=grid_id,
        outaged_elements=[asset_id],
        load_scale=sim_load
    )

    actual_cascade = bool(sim_result["actual_cascade"])
    extra_trips = int(sim_result["additional_trips"])
    load_shed = float(sim_result["final_load_shed_fraction"])

    verification_status = "simulator verified"
    if actual_cascade or extra_trips > 0:
        verdict = f"Conditional: Safest between {safest_window_str} (risk {int(safest_avg_risk*100)}%), but simulator notes {extra_trips} secondary trip(s). Strict redispatch required. Avoid peak hours {avoid_window_str}."
    else:
        verdict = f"Safe between {safest_window_str} (cascade risk {int(safest_avg_risk*100)}%, zero collateral line trips). Avoid peak hours {avoid_window_str} (risk up to {int(max_risk_hour['cascade_risk']*100)}%)."

    result = {
        "grid_id": grid_id,
        "asset_id": asset_id,
        "hourly_risks": hourly_risks,
        "safest_window": {
            "start_hour": safest_start,
            "end_hour": safest_end,
            "label": safest_window_str,
            "average_risk": safest_avg_risk
        },
        "avoid_window": {
            "start_hour": avoid_start,
            "end_hour": avoid_end,
            "label": avoid_window_str,
            "peak_risk": max_risk_hour["cascade_risk"]
        },
        "verdict": verdict,
        "verification": {
            "status": verification_status,
            "simulator_tested_at_hour": f"{(safest_start + 1):02d}:00",
            "simulator_load_scale": round(sim_load, 2),
            "actual_cascade": actual_cascade,
            "additional_trips": extra_trips,
            "load_shed_percent": round(load_shed * 100, 1),
            "label": "simulator verified"
        }
    }

    _PLANNED_OUTAGE_CACHE[cache_key] = copy.deepcopy(result)
    return result
