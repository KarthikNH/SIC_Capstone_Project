"""
Dataset splitting engine and tabular baseline feature extractor.

Generates three evaluation splits:
1. Random Stratified Split.
2. Contingency-Held-Out Split (Grouped by contingency_id; guaranteed zero contingency overlap).
3. Operating-Point-Held-Out Split (Unseen extreme load regimes).

Also extracts domain-engineered tabular features for classical ML baselines.
"""

import os
import sys
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from typing import Any, Dict, List, Set, Tuple
import pickle
import numpy as np
import pandas as pd
import torch
import networkx as nx
from sklearn.model_selection import StratifiedShuffleSplit
import pandapower as pp
import pandapower.networks as pn

from src.utils.config import load_config
from src.utils.seed import set_seed


def build_network_graph(case_name: str = "case30") -> Tuple[nx.Graph, Dict[int, int], Dict[int, float]]:
    """
    Build NetworkX graph for topology and centrality analysis.

    Args:
        case_name (str): 'case30' or 'case118'.

    Returns:
        Tuple[nx.Graph, Dict[int, int], Dict[int, float]]: (Graph, node_degrees, betweenness_centrality)
    """
    if case_name == "case30":
        net = pn.case30()
    elif case_name == "case118":
        net = pn.case118()
    else:
        net = pn.case30()

    G = nx.Graph()
    for b in net.bus.index:
        G.add_node(int(b))

    for _, r in net.line.iterrows():
        G.add_edge(int(r.from_bus), int(r.to_bus), weight=float(r.x_ohm_per_km))

    for _, r in net.trafo.iterrows():
        G.add_edge(int(r.hv_bus), int(r.lv_bus), weight=0.05)

    degrees = dict(G.degree())
    betweenness = nx.betweenness_centrality(G)
    return G, degrees, betweenness


def create_random_split(
    df: pd.DataFrame,
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    seed: int = 42
) -> Dict[str, np.ndarray]:
    """
    Create a stratified random train/val/test split based on binary cascade label.

    Args:
        df (pd.DataFrame): Dataset DataFrame containing 'cascade' label.
        train_ratio (float): Ratio for training set.
        val_ratio (float): Ratio for validation set.
        test_ratio (float): Ratio for test set.
        seed (int): Random seed.

    Returns:
        Dict[str, np.ndarray]: Dictionary with 'train', 'val', 'test' integer indices.
    """
    y = df["cascade"].values
    n = len(df)

    test_val_ratio = val_ratio + test_ratio
    sss1 = StratifiedShuffleSplit(n_splits=1, test_size=test_val_ratio, random_state=seed)
    train_idx, temp_idx = next(sss1.split(np.zeros(n), y))

    relative_test_ratio = test_ratio / test_val_ratio
    sss2 = StratifiedShuffleSplit(n_splits=1, test_size=relative_test_ratio, random_state=seed)
    val_rel_idx, test_rel_idx = next(sss2.split(np.zeros(len(temp_idx)), y[temp_idx]))

    val_idx = temp_idx[val_rel_idx]
    test_idx = temp_idx[test_rel_idx]

    return {
        "train": np.sort(train_idx),
        "val": np.sort(val_idx),
        "test": np.sort(test_idx)
    }


def create_contingency_held_out_split(
    df: pd.DataFrame,
    test_contingency_ratio: float = 0.20,
    val_contingency_ratio: float = 0.15,
    seed: int = 42
) -> Dict[str, np.ndarray]:
    """
    Create a contingency-held-out split where contingencies in test/val sets
    NEVER appear in the training set.

    Args:
        df (pd.DataFrame): Dataset DataFrame.
        test_contingency_ratio (float): Proportion of unique contingencies for test.
        val_contingency_ratio (float): Proportion of unique contingencies for val.
        seed (int): Random seed.

    Returns:
        Dict[str, np.ndarray]: Dictionary with 'train', 'val', 'test' indices.
    """
    rng = np.random.default_rng(seed)

    # Group scenarios by contingency_id and calculate their cascade rate
    contingency_stats = df.groupby("contingency_id").agg(
        count=("cascade", "count"),
        positives=("cascade", "sum"),
        cascade_rate=("cascade", "mean")
    ).reset_index()

    # Stratify unique contingencies into categories (predominantly cascade, safe, mixed)
    def categorize(rate: float) -> int:
        if rate >= 0.60:
            return 2  # high cascade
        elif rate <= 0.20:
            return 0  # low cascade
        return 1      # intermediate

    contingency_stats["strata"] = contingency_stats["cascade_rate"].apply(categorize)

    test_contingencies: Set[str] = set()
    val_contingencies: Set[str] = set()
    train_contingencies: Set[str] = set()

    for stratum, group in contingency_stats.groupby("strata"):
        conts = group["contingency_id"].values.copy()
        rng.shuffle(conts)
        n_group = len(conts)
        n_test = max(1, int(round(n_group * test_contingency_ratio)))
        n_val = max(1, int(round(n_group * val_contingency_ratio)))

        test_contingencies.update(conts[:n_test])
        val_contingencies.update(conts[n_test:n_test + n_val])
        train_contingencies.update(conts[n_test + n_val:])

    train_idx = df[df["contingency_id"].isin(train_contingencies)].index.values
    val_idx = df[df["contingency_id"].isin(val_contingencies)].index.values
    test_idx = df[df["contingency_id"].isin(test_contingencies)].index.values

    return {
        "train": np.sort(train_idx),
        "val": np.sort(val_idx),
        "test": np.sort(test_idx)
    }


def create_operating_point_held_out_split(
    df: pd.DataFrame,
    high_load_quantile: float = 0.80,
    val_ratio: float = 0.15,
    seed: int = 42
) -> Dict[str, np.ndarray]:
    """
    Create an operating-point-held-out split where high stress load conditions
    are reserved exclusively for testing out-of-distribution generalization.

    Args:
        df (pd.DataFrame): Dataset DataFrame.
        high_load_quantile (float): Quantile threshold for test load.
        val_ratio (float): Validation proportion from remaining data.
        seed (int): Random seed.

    Returns:
        Dict[str, np.ndarray]: Dictionary with 'train', 'val', 'test' indices.
    """
    threshold = df["pre_contingency_load_mw"].quantile(high_load_quantile)
    test_idx = df[df["pre_contingency_load_mw"] >= threshold].index.values
    remaining_idx = df[df["pre_contingency_load_mw"] < threshold].index.values

    # Stratify remaining into train and val
    y_remaining = df.loc[remaining_idx, "cascade"].values
    sss = StratifiedShuffleSplit(n_splits=1, test_size=val_ratio, random_state=seed)
    train_rel, val_rel = next(sss.split(np.zeros(len(remaining_idx)), y_remaining))

    train_idx = remaining_idx[train_rel]
    val_idx = remaining_idx[val_rel]

    return {
        "train": np.sort(train_idx),
        "val": np.sort(val_idx),
        "test": np.sort(test_idx)
    }


def verify_split_assertions(
    splits: Dict[str, Dict[str, np.ndarray]],
    df: pd.DataFrame
) -> Dict[str, Dict[str, Any]]:
    """
    Verify strict leakage and exclusivity assertions across all splits.

    Assertions:
    1. No scenario is present in more than one subset within a split.
    2. Union of subsets covers all scenarios.
    3. For contingency-held-out split: zero overlap between train, val, and test contingency sets.

    Args:
        splits (Dict[str, Dict[str, np.ndarray]]): Nested dictionary of split indices.
        df (pd.DataFrame): Scenario DataFrame.

    Returns:
        Dict[str, Dict[str, Any]]: Audit report for each split.
    """
    audit = {}
    total_len = len(df)

    for split_name, subsets in splits.items():
        train_idx = set(subsets["train"])
        val_idx = set(subsets["val"])
        test_idx = set(subsets["test"])

        # Disjoint checks
        train_val_overlap = len(train_idx.intersection(val_idx))
        train_test_overlap = len(train_idx.intersection(test_idx))
        val_test_overlap = len(val_idx.intersection(test_idx))

        assert train_val_overlap == 0, f"Leakage in {split_name}: train/val overlap!"
        assert train_test_overlap == 0, f"Leakage in {split_name}: train/test overlap!"
        assert val_test_overlap == 0, f"Leakage in {split_name}: val/test overlap!"

        union_size = len(train_idx | val_idx | test_idx)
        assert union_size == total_len, f"Partition incomplete in {split_name}: {union_size} != {total_len}"

        contingency_leakage = 0
        if split_name == "contingency_held_out":
            train_conts = set(df.loc[subsets["train"], "contingency_id"])
            val_conts = set(df.loc[subsets["val"], "contingency_id"])
            test_conts = set(df.loc[subsets["test"], "contingency_id"])

            overlap_train_test = train_conts.intersection(test_conts)
            overlap_train_val = train_conts.intersection(val_conts)
            overlap_val_test = val_conts.intersection(test_conts)

            contingency_leakage = len(overlap_train_test) + len(overlap_train_val) + len(overlap_val_test)
            assert len(overlap_train_test) == 0, f"Contingency leakage: {overlap_train_test} in train and test!"
            assert len(overlap_train_val) == 0, f"Contingency leakage: {overlap_train_val} in train and val!"
            assert len(overlap_val_test) == 0, f"Contingency leakage: {overlap_val_test} in val and test!"

        audit[split_name] = {
            "train_size": len(train_idx),
            "val_size": len(val_idx),
            "test_size": len(test_idx),
            "train_cascade_rate": float(df.loc[subsets["train"], "cascade"].mean() * 100),
            "val_cascade_rate": float(df.loc[subsets["val"], "cascade"].mean() * 100),
            "test_cascade_rate": float(df.loc[subsets["test"], "cascade"].mean() * 100),
            "sample_overlap": train_val_overlap + train_test_overlap + val_test_overlap,
            "contingency_overlap": contingency_leakage,
            "passed": True
        }

    return audit


def extract_tabular_features(
    scenarios: List[Dict[str, Any]],
    case_name: str = "case30"
) -> pd.DataFrame:
    """
    Extract flat domain-engineered tabular features for classical ML baselines.

    Features:
    - Line loading stats (max, mean, std, counts > 80%, 90%, 100%, 110%)
    - Voltage stats (min, max, mean, std, counts < 0.95 pu, > 1.05 pu)
    - Total load and total generation
    - Failed element graph topology features (degree, betweenness, type)

    Args:
        scenarios (List[Dict[str, Any]]): List of raw scenario payloads.
        case_name (str): 'case30' or 'case118'.

    Returns:
        pd.DataFrame: Tabular features DataFrame.
    """
    _, degrees, betweenness = build_network_graph(case_name)

    rows = []
    for sc in scenarios:
        fs = sc["first_state"]
        bus_d = fs["bus"]
        br_d = fs["branch"]
        lbl = sc["labels"]

        # Voltage statistics
        vm = bus_d["vm_pu"]
        v_min = float(np.min(vm))
        v_max = float(np.max(vm))
        v_mean = float(np.mean(vm))
        v_std = float(np.std(vm))
        n_buses_under_095 = int(np.sum(vm < 0.95))
        n_buses_over_105 = int(np.sum(vm > 1.05))

        # Branch loading statistics
        loadings = br_d["loading_percent"]
        load_max = float(np.max(loadings))
        load_mean = float(np.mean(loadings))
        load_std = float(np.std(loadings))
        n_lines_over_80 = int(np.sum(loadings > 80.0))
        n_lines_over_90 = int(np.sum(loadings > 90.0))
        n_lines_over_100 = int(np.sum(loadings > 100.0))
        n_lines_over_110 = int(np.sum(loadings > 110.0))

        # Power balance
        tot_load = float(np.sum(bus_d["p_load_mw"]))
        tot_gen = float(np.sum(bus_d["p_gen_mw"]))

        # Failed element features
        c_type = sc["contingency_type"]
        out_indices = sc["outaged_indices"]
        is_line = 1 if "line" in c_type else 0
        is_gen = 1 if "gen" in c_type else 0
        is_n2 = 1 if "N-2" in c_type else 0

        # Degree and betweenness of outaged elements
        elem_degrees = []
        elem_betw = []
        if is_line:
            for idx in out_indices:
                matches = np.where(br_d["line_id"] == idx)[0]
                for m in matches:
                    u = int(br_d["from_bus"][m])
                    v = int(br_d["to_bus"][m])
                    elem_degrees.extend([degrees.get(u, 0), degrees.get(v, 0)])
                    elem_betw.extend([betweenness.get(u, 0.0), betweenness.get(v, 0.0)])
        else:
            # Generator bus
            gen_buses = [int(bus_d["bus_id"][i]) for i, is_g in enumerate(bus_d["is_gen"]) if is_g > 0.5]
            for gb in gen_buses:
                elem_degrees.append(degrees.get(gb, 0))
                elem_betw.append(betweenness.get(gb, 0.0))

        failed_degree_mean = float(np.mean(elem_degrees)) if elem_degrees else 0.0
        failed_betw_mean = float(np.mean(elem_betw)) if elem_betw else 0.0

        rows.append({
            "scenario_id": sc["scenario_id"],
            "contingency_id": sc["contingency_id"],
            "contingency_type": sc["contingency_type"],
            "pre_contingency_load_mw": sc["pre_contingency_load_mw"],
            # Loading features
            "max_line_loading": load_max,
            "mean_line_loading": load_mean,
            "std_line_loading": load_std,
            "n_lines_over_80": n_lines_over_80,
            "n_lines_over_90": n_lines_over_90,
            "n_lines_over_100": n_lines_over_100,
            "n_lines_over_110": n_lines_over_110,
            # Voltage features
            "min_voltage_pu": v_min,
            "max_voltage_pu": v_max,
            "mean_voltage_pu": v_mean,
            "std_voltage_pu": v_std,
            "n_buses_under_095": n_buses_under_095,
            "n_buses_over_105": n_buses_over_105,
            # Power balance
            "total_load_mw": tot_load,
            "total_gen_mw": tot_gen,
            "net_power_balance_mw": tot_gen - tot_load,
            # Failed element graph topology features
            "failed_element_degree_mean": failed_degree_mean,
            "failed_element_betweenness_mean": failed_betw_mean,
            "is_line_contingency": is_line,
            "is_gen_contingency": is_gen,
            "is_n2_contingency": is_n2,
            # Targets
            "cascade": lbl["cascade"],
            "additional_trips": lbl["additional_trips"],
            "load_shed_fraction": lbl["load_shed_fraction"],
            "load_shed_mw": lbl["load_shed_mw"]
        })

    return pd.DataFrame(rows)


def build_and_save_all_datasets(config_path: str = "config.yaml") -> Dict[str, Any]:
    """
    Main orchestration routine for Step 2:
    1. Load raw scenarios.
    2. Build PyG Data objects.
    3. Generate the 3 evaluation splits.
    4. Fit and apply PowerGridScaler on training graphs only.
    5. Extract flat tabular features with split indicators.
    6. Save PyG dataset, tabular dataset, scalers, and split indices to data/processed.

    Args:
        config_path (str): Path to config YAML.

    Returns:
        Dict[str, Any]: Execution summary and verification audit.
    """
    from src.graph_dataset import build_pyg_dataset, PowerGridScaler

    cfg = load_config(config_path)
    seed = cfg.get("project", {}).get("seed", 42)
    set_seed(seed)

    raw_dir = Path(cfg["dataset"].get("raw_data_dir", "data/raw"))
    proc_dir = Path(cfg["dataset"].get("processed_data_dir", "data/processed"))
    proc_dir.mkdir(parents=True, exist_ok=True)

    pkl_file = raw_dir / cfg["dataset"].get("raw_backup_pickle", "scenarios_raw.pkl")
    with open(pkl_file, "rb") as f:
        scenarios = pickle.load(f)

    print(f"Loaded {len(scenarios)} scenarios from {pkl_file}.")

    # 1. Build Tabular Features
    case_name = cfg["grid"].get("case_name", "case30")
    df_tabular = extract_tabular_features(scenarios, case_name)

    # 2. Build the Three Splits
    splits_cfg = cfg["dataset"].get("splits", {})
    random_cfg = splits_cfg.get("random", {})
    contingency_cfg = splits_cfg.get("contingency_held_out", {})
    op_cfg = splits_cfg.get("operating_point_held_out", {})

    random_split = create_random_split(
        df_tabular,
        train_ratio=random_cfg.get("train_ratio", 0.70),
        val_ratio=random_cfg.get("val_ratio", 0.15),
        test_ratio=random_cfg.get("test_ratio", 0.15),
        seed=seed
    )

    contingency_split = create_contingency_held_out_split(
        df_tabular,
        test_contingency_ratio=contingency_cfg.get("test_contingency_ratio", 0.20),
        val_contingency_ratio=contingency_cfg.get("val_contingency_ratio", 0.15),
        seed=seed
    )

    operating_point_split = create_operating_point_held_out_split(
        df_tabular,
        high_load_quantile=op_cfg.get("high_load_quantile", 0.80),
        val_ratio=op_cfg.get("val_ratio", 0.15),
        seed=seed
    )

    splits = {
        "random": random_split,
        "contingency_held_out": contingency_split,
        "operating_point_held_out": operating_point_split
    }

    # 3. Verify Strict Leakage Assertions
    audit = verify_split_assertions(splits, df_tabular)

    # Attach split assignments to tabular DataFrame
    for split_name, sub in splits.items():
        col_name = f"split_{split_name}"
        df_tabular[col_name] = "train"
        df_tabular.loc[sub["val"], col_name] = "val"
        df_tabular.loc[sub["test"], col_name] = "test"

    # Save tabular features
    tab_parquet_path = proc_dir / cfg["dataset"].get("tabular_features_file", "tabular_features.parquet")
    df_tabular.to_parquet(tab_parquet_path, engine="pyarrow", index=False)
    print(f"Saved tabular features ({df_tabular.shape}) to {tab_parquet_path}.")

    # 4. Build PyG Graphs
    print("Building PyTorch Geometric graph dataset...")
    graphs = build_pyg_dataset(scenarios, cfg)

    # 5. Fit Scaler strictly on primary training set (contingency_held_out train set)
    primary_train_idx = contingency_split["train"]
    primary_train_graphs = [graphs[i] for i in primary_train_idx]

    node_cont_dim = graphs[0].continuous_node_dim
    edge_cont_dim = graphs[0].continuous_edge_dim

    scaler = PowerGridScaler(node_cont_dim, edge_cont_dim)
    scaler.fit(primary_train_graphs)

    scaler_path = proc_dir / cfg["dataset"].get("scalers_file", "scalers.pkl")
    scaler.save(scaler_path)
    print(f"Fitted scaler on {len(primary_train_graphs)} training graphs. Saved to {scaler_path}.")

    # Apply scaler to all graphs
    norm_graphs = scaler.transform_list(graphs)

    # Save PyG graphs
    pyg_path = proc_dir / cfg["dataset"].get("processed_graphs_file", "graph_dataset.pt")
    torch.save(norm_graphs, pyg_path)
    print(f"Saved {len(norm_graphs)} normalized PyG Data graphs to {pyg_path}.")

    # Save split indices dictionary
    split_indices_path = proc_dir / cfg["dataset"].get("split_indices_file", "split_indices.pkl")
    with open(split_indices_path, "wb") as f:
        pickle.dump(splits, f)
    print(f"Saved split indices to {split_indices_path}.")

    return {
        "audit": audit,
        "splits": splits,
        "n_graphs": len(norm_graphs),
        "tabular_shape": df_tabular.shape
    }


if __name__ == "__main__":
    build_and_save_all_datasets()
