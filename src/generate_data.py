"""
Multiprocessing dataset generator for power grid cascading failure simulation.

Saves scenarios to data/raw with strict isolation of the first post-contingency state.
"""

import argparse
import os
import pickle
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from tqdm import tqdm

# Ensure src package is importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.simulator import load_grid, simulate_scenario
from src.utils.config import load_config
from src.utils.seed import set_seed


def _worker_simulate(args: Tuple[int, int, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Worker function executed by each subprocess.

    Args:
        args: Tuple containing (scenario_id, seed, config)

    Returns:
        Optional[Dict[str, Any]]: Scenario dictionary or None if invalid.
    """
    scenario_id, seed, config = args
    case_name = config.get("grid", {}).get("case_name", "case30")
    # Each worker loads its own pristine network instance
    base_net = load_grid(case_name, config)
    return simulate_scenario(base_net, scenario_id=scenario_id, seed=seed, config=config)


def generate_dataset(
    config_path: str = "config.yaml",
    n_scenarios_override: Optional[int] = None,
    case_name_override: Optional[str] = None,
    n_jobs_override: Optional[int] = None
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Generate dataset of cascading failure simulations across multiple CPU processes.

    Args:
        config_path (str): Path to configuration YAML.
        n_scenarios_override (Optional[int]): Override scenario count from config.
        case_name_override (Optional[str]): Override grid case name.
        n_jobs_override (Optional[int]): Override worker process count.

    Returns:
        Tuple[pd.DataFrame, Dict[str, Any]]: (scenarios_df, statistics_dict)
    """
    config = load_config(config_path)

    if case_name_override:
        config["grid"]["case_name"] = case_name_override
    if n_scenarios_override:
        config["dataset"]["n_scenarios"] = n_scenarios_override
    if n_jobs_override:
        config["dataset"]["n_jobs"] = n_jobs_override

    base_seed = config.get("project", {}).get("seed", 42)
    set_seed(base_seed)

    case_name = config["grid"]["case_name"]
    target_scenarios = config["dataset"]["n_scenarios"]
    n_jobs = config["dataset"].get("n_jobs", 4)
    if n_jobs <= 0 or n_jobs == -1:
        n_jobs = os.cpu_count() or 4

    raw_dir = Path(config["dataset"].get("raw_data_dir", "data/raw"))
    raw_dir.mkdir(parents=True, exist_ok=True)

    print(f"============================================================")
    print(f"Generating Cascading Failure Dataset")
    print(f"Grid Case: {case_name}")
    print(f"Target Scenarios: {target_scenarios}")
    print(f"Parallel Workers: {n_jobs}")
    print(f"Random Seed: {base_seed}")
    print(f"Load Range: [{config['simulation']['min_load_scale']}, {config['simulation']['max_load_scale']}]")
    print(f"Line Limit Factor: {config['simulation']['line_limit_factor']}")
    print(f"Cascade Trigger: >= {config['simulation']['cascade_trip_threshold']} trips OR "
          f">= {config['simulation']['cascade_load_shed_threshold']*100:.0f}% load shed")
    print(f"============================================================")

    collected_scenarios: List[Dict[str, Any]] = []
    current_scenario_id = 0
    seed_counter = base_seed

    pbar = tqdm(total=target_scenarios, desc="Simulating Scenarios", unit="scenario")

    batch_size = max(10, n_jobs * 4)
    start_time = time.time()

    with ProcessPoolExecutor(max_workers=n_jobs) as executor:
        while len(collected_scenarios) < target_scenarios:
            remaining = target_scenarios - len(collected_scenarios)
            current_batch_size = max(remaining, batch_size)

            tasks = []
            for _ in range(current_batch_size):
                tasks.append(
                    (current_scenario_id, seed_counter, config)
                )
                current_scenario_id += 1
                seed_counter += 1

            futures = [executor.submit(_worker_simulate, t) for t in tasks]

            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result is not None and len(collected_scenarios) < target_scenarios:
                        collected_scenarios.append(result)
                        pbar.update(1)
                except Exception as e:
                    # Ignore occasional solver issues and continue
                    pass

    pbar.close()
    elapsed = time.time() - start_time
    print(f"\nGenerated {len(collected_scenarios)} scenarios in {elapsed:.1f}s ({len(collected_scenarios)/elapsed:.1f} sc/s)")

    # Build clean tabular representation
    rows = []
    for sc in collected_scenarios:
        rows.append({
            "scenario_id": sc["scenario_id"],
            "contingency_id": sc["contingency_id"],
            "contingency_type": sc["contingency_type"],
            "operating_point_id": f"seed_{sc['seed']}",
            "pre_contingency_load_mw": sc["pre_contingency_load_mw"],
            "first_state": sc["first_state"],  # Dict of bus, branch, trafo post-contingency features
            "cascade": sc["labels"]["cascade"],
            "additional_trips": sc["labels"]["additional_trips"],
            "load_shed_fraction": sc["labels"]["load_shed_fraction"],
            "load_shed_mw": sc["labels"]["load_shed_mw"],
            "cascade_iterations": sc["labels"]["cascade_iterations"],
            "termination_reason": sc["labels"]["termination_reason"],
            "tripped_branch_indices": sc["labels"]["tripped_branch_indices"]
        })

    df = pd.DataFrame(rows)

    # Save to disk
    pickle_path = raw_dir / config["dataset"].get("raw_backup_pickle", "scenarios_raw.pkl")
    parquet_path = raw_dir / config["dataset"].get("raw_file_name", "scenarios_raw.parquet")

    # Native Python pickle stores full numpy arrays in first_state without schema truncation
    with open(pickle_path, "wb") as f:
        pickle.dump(collected_scenarios, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"Saved complete raw dataset pickle to: {pickle_path}")

    # Parquet export: serialize complex dict column to bytes for fast structured columnar access
    df_parquet = df.copy()
    df_parquet["first_state"] = df_parquet["first_state"].apply(pickle.dumps)
    df_parquet["tripped_branch_indices"] = df_parquet["tripped_branch_indices"].apply(str)
    df_parquet.to_parquet(parquet_path, engine="pyarrow", index=False)
    print(f"Saved tabular metadata and features to: {parquet_path}")

    # Compute Statistics & Class Balance
    n_total = len(df)
    n_cascade = int(df["cascade"].sum())
    n_no_cascade = n_total - n_cascade
    cascade_pct = (n_cascade / n_total) * 100.0 if n_total > 0 else 0.0

    stats = {
        "n_total": n_total,
        "n_cascade": n_cascade,
        "n_no_cascade": n_no_cascade,
        "cascade_rate_percent": cascade_pct,
        "additional_trips_mean": float(df["additional_trips"].mean()),
        "additional_trips_max": int(df["additional_trips"].max()),
        "load_shed_mean": float(df["load_shed_fraction"].mean()),
        "contingency_distribution": df["contingency_type"].value_counts().to_dict(),
        "termination_distribution": df["termination_reason"].value_counts().to_dict()
    }

    print(f"\n============================================================")
    print(f"DATASET SUMMARY & CLASS BALANCE")
    print(f"============================================================")
    print(f"Total Scenarios : {n_total}")
    print(f"Cascade (1)     : {n_cascade} ({cascade_pct:.2f}%)")
    print(f"No Cascade (0)  : {n_no_cascade} ({100.0 - cascade_pct:.2f}%)")
    print(f"Contingencies   : {stats['contingency_distribution']}")
    print(f"Terminations    : {stats['termination_distribution']}")
    print(f"Additional Trips: mean={stats['additional_trips_mean']:.2f}, max={stats['additional_trips_max']}")
    print(f"Load Shed Frac  : mean={stats['load_shed_mean']:.4f}")
    print(f"============================================================")

    if cascade_pct < 5.0:
        print(f"\n[WARNING] Cascade positive rate is {cascade_pct:.2f}% (< 5%).")
        print(f"Recommendation to balance classes:")
        print(f"  1. Increase upper load scale: min_load_scale=0.75, max_load_scale=1.25")
        print(f"  2. Lower line_limit_factor: e.g., line_limit_factor=1.10 or 1.05")
        print(f"  3. Increase proportion of N-2 line outages in contingency probabilities.")

    return df, stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate cascading failure power grid dataset.")
    parser.add_argument("--config", type=str, default="config.yaml", help="Path to config YAML")
    parser.add_argument("--scenarios", type=int, default=None, help="Number of scenarios to simulate")
    parser.add_argument("--case", type=str, default=None, help="Grid case name (case30, case118)")
    parser.add_argument("--jobs", type=int, default=None, help="Number of worker processes")
    args = parser.parse_args()

    df, stats = generate_dataset(
        config_path=args.config,
        n_scenarios_override=args.scenarios,
        case_name_override=args.case,
        n_jobs_override=args.jobs
    )
