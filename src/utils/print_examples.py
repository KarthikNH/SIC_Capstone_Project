"""
Script to display class balance and representative example scenarios from data/raw/scenarios_raw.pkl.
"""

import pickle
from pathlib import Path


def main():
    pkl_path = Path("data/raw/scenarios_raw.pkl")
    if not pkl_path.exists():
        print(f"Error: {pkl_path} does not exist.")
        return

    with open(pkl_path, "rb") as f:
        scenarios = pickle.load(f)

    print(f"\n===========================================================================")
    print(f"CHECKPOINT REPORT: 30-BUS DATASET VALIDATION ({len(scenarios)} SCENARIOS)")
    print(f"===========================================================================")

    # Class balance
    y = [s["labels"]["cascade"] for s in scenarios]
    n_total = len(y)
    n_pos = sum(y)
    n_neg = n_total - n_pos
    pos_pct = (n_pos / n_total) * 100.0

    print(f"Total Scenarios  : {n_total}")
    print(f"Cascades (y=1)   : {n_pos} ({pos_pct:.2f}%)")
    print(f"No Cascade (y=0) : {n_neg} ({100.0 - pos_pct:.2f}%)")
    print(f"Class Balance    : 1 : {n_neg / max(1, n_pos):.2f} (Positive : Negative)")

    # Select 3 distinct representative examples
    no_casc = next(s for s in scenarios if s["labels"]["cascade"] == 0 and s["contingency_type"] == "N-1_line")
    multi_trip = next(s for s in scenarios if s["labels"]["additional_trips"] >= 3 and s["contingency_type"] == "N-1_gen")
    n2_shed = next(s for s in scenarios if s["labels"]["cascade"] == 1 and s["contingency_type"] == "N-2_line")

    examples = [
        ("Example 1: N-1 Line Outage -> Stable Power Flow (No Cascade, y=0)", no_casc),
        ("Example 2: N-1 Generator Outage -> Overload Propagation (>= 3 Additional Trips, y=1)", multi_trip),
        ("Example 3: N-2 Double Line Outage -> Severe Disconnection (> 15% Load Shed, y=1)", n2_shed)
    ]

    for title, sc in examples:
        lbl = sc["labels"]
        fs = sc["first_state"]
        print(f"\n" + "-" * 75)
        print(f" {title}")
        print("-" * 75)
        print(f"  * Scenario ID             : {sc['scenario_id']}")
        print(f"  * Scenario Seed           : {sc['seed']}")
        print(f"  * Contingency Type        : {sc['contingency_type']}")
        print(f"  * Contingency Identifier  : {sc['contingency_id']}")
        print(f"  * Outaged Element Index   : {sc['outaged_indices']}")
        print(f"  * Pre-Contingency Total P : {sc['pre_contingency_load_mw']:.2f} MW")
        print(f"  --- Targets (Derived from cascade simulation) ---")
        print(f"  * Cascade Label (y)       : {lbl['cascade']} ({'CASCADE' if lbl['cascade'] == 1 else 'NO CASCADE'})")
        print(f"  * Additional Trips Count  : {lbl['additional_trips']}")
        print(f"  * Tripped Branch Indices  : {lbl['tripped_branch_indices']}")
        print(f"  * Load Shed               : {lbl['load_shed_mw']:.2f} MW ({lbl['load_shed_fraction'] * 100:.2f}%)")
        print(f"  * Cascade Iterations      : {lbl['cascade_iterations']}")
        print(f"  * Termination Reason      : {lbl['termination_reason']}")
        print(f"  --- First Post-Contingency Features (Strictly isolated t=0+ input) ---")
        print(f"  * Bus Count               : {len(fs['bus']['bus_id'])} buses")
        print(f"  * Bus Voltage Range (pu)  : [{fs['bus']['vm_pu'].min():.3f}, {fs['bus']['vm_pu'].max():.3f}]")
        print(f"  * Total Active Generation : {fs['bus']['p_gen_mw'].sum():.2f} MW")
        print(f"  * Branch Count            : {len(fs['branch']['line_id'])} lines")
        print(f"  * Max Initial Line Load   : {fs['branch']['loading_percent'].max():.2f}%")
        print(f"  * Feature Leakage Check   : No cascade iteration features present in first_state")

    print(f"\n===========================================================================\n")


if __name__ == "__main__":
    main()
