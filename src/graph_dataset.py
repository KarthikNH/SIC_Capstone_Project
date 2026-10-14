"""
Graph dataset builder for PyTorch Geometric (PyG).

Converts power grid post-contingency states into PyG Data objects:
- Nodes: Buses with electrical & topological features.
- Edges: Transmission lines & transformers (bidirectional) with electrical parameters & flows.
- Labels: Binary cascade target and secondary continuous targets.
- Scalers: Normalized using statistics computed on the TRAINING set only (leakage-free).
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import pickle
import numpy as np
import torch
from torch_geometric.data import Data


class PowerGridScaler:
    """
    StandardScaler for PyG graph datasets.
    Computes mean and std statistics strictly on training graphs.
    """

    def __init__(self, continuous_node_dim: int, continuous_edge_dim: int):
        self.continuous_node_dim = continuous_node_dim
        self.continuous_edge_dim = continuous_edge_dim
        self.node_mean: Optional[torch.Tensor] = None
        self.node_std: Optional[torch.Tensor] = None
        self.edge_mean: Optional[torch.Tensor] = None
        self.edge_std: Optional[torch.Tensor] = None

    def fit(self, train_graphs: List[Data]) -> "PowerGridScaler":
        """
        Fit scaler statistics on training set graphs only.

        Args:
            train_graphs (List[Data]): List of PyG Data objects from training set.

        Returns:
            PowerGridScaler: Self with computed statistics.
        """
        # Collect continuous node features across training graphs
        all_node_feats = []
        all_edge_feats = []

        for g in train_graphs:
            all_node_feats.append(g.x[:, :self.continuous_node_dim])
            all_edge_feats.append(g.edge_attr[:, :self.continuous_edge_dim])

        concat_nodes = torch.cat(all_node_feats, dim=0)
        concat_edges = torch.cat(all_edge_feats, dim=0)

        self.node_mean = concat_nodes.mean(dim=0)
        self.node_std = concat_nodes.std(dim=0)
        # Avoid division by zero
        self.node_std = torch.where(self.node_std < 1e-6, torch.ones_like(self.node_std), self.node_std)

        self.edge_mean = concat_edges.mean(dim=0)
        self.edge_std = concat_edges.std(dim=0)
        self.edge_std = torch.where(self.edge_std < 1e-6, torch.ones_like(self.edge_std), self.edge_std)

        return self

    def transform_graph(self, data: Data) -> Data:
        """
        Normalize a single PyG Data instance.

        Args:
            data (Data): PyG Data object.

        Returns:
            Data: Cloned Data object with normalized continuous features.
        """
        data_norm = data.clone()

        # Normalize continuous node features
        norm_node = (data_norm.x[:, :self.continuous_node_dim] - self.node_mean) / self.node_std
        data_norm.x = torch.cat([norm_node, data_norm.x[:, self.continuous_node_dim:]], dim=1)

        # Normalize continuous edge features
        norm_edge = (data_norm.edge_attr[:, :self.continuous_edge_dim] - self.edge_mean) / self.edge_std
        data_norm.edge_attr = torch.cat([norm_edge, data_norm.edge_attr[:, self.continuous_edge_dim:]], dim=1)

        return data_norm

    def transform_list(self, graphs: List[Data]) -> List[Data]:
        """
        Normalize a list of PyG Data instances.

        Args:
            graphs (List[Data]): List of PyG Data objects.

        Returns:
            List[Data]: Normalized graphs.
        """
        return [self.transform_graph(g) for g in graphs]

    def save(self, filepath: Union[str, Path]) -> None:
        """Save scaler parameters to disk."""
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, "wb") as f:
            pickle.dump({
                "continuous_node_dim": self.continuous_node_dim,
                "continuous_edge_dim": self.continuous_edge_dim,
                "node_mean": self.node_mean,
                "node_std": self.node_std,
                "edge_mean": self.edge_mean,
                "edge_std": self.edge_std
            }, f)

    @classmethod
    def load(cls, filepath: Union[str, Path]) -> "PowerGridScaler":
        """Load scaler parameters from disk."""
        with open(filepath, "rb") as f:
            data = pickle.load(f)
        scaler = cls(data["continuous_node_dim"], data["continuous_edge_dim"])
        scaler.node_mean = data["node_mean"]
        scaler.node_std = data["node_std"]
        scaler.edge_mean = data["edge_mean"]
        scaler.edge_std = data["edge_std"]
        return scaler


def scenario_to_pyg_data(scenario: Dict[str, Any], config: Dict[str, Any]) -> Data:
    """
    Convert a single simulated scenario into a PyTorch Geometric Data object.

    Args:
        scenario (Dict[str, Any]): Dictionary containing scenario metadata, first_state, and labels.
        config (Dict[str, Any]): Configuration dictionary.

    Returns:
        Data: PyG Data graph object.
    """
    first_state = scenario["first_state"]
    bus_data = first_state["bus"]
    branch_data = first_state["branch"]
    trafo_data = first_state.get("trafo")
    labels = scenario["labels"]

    include_delta = config.get("dataset", {}).get("include_delta_features", True)
    line_limit_factor = config.get("simulation", {}).get("line_limit_factor", 1.15)

    n_buses = len(bus_data["bus_id"])
    bus_id_map = {int(b): idx for idx, b in enumerate(bus_data["bus_id"])}

    # Identify endpoints of outaged elements
    outaged_bus_indices = set()
    contingency_type = scenario["contingency_type"]
    outaged_indices = scenario["outaged_indices"]

    if "line" in contingency_type:
        for line_idx in outaged_indices:
            matches = np.where(branch_data["line_id"] == line_idx)[0]
            for m in matches:
                outaged_bus_indices.add(bus_id_map[int(branch_data["from_bus"][m])])
                outaged_bus_indices.add(bus_id_map[int(branch_data["to_bus"][m])])
    elif "gen" in contingency_type:
        for gen_idx in outaged_indices:
            # The generator bus in pandapower
            outaged_bus_indices.update([idx for idx, is_g in enumerate(bus_data["is_gen"]) if is_g > 0.5])

    # --------------------------------------------------------------------------
    # 1. Node Features (Buses)
    # --------------------------------------------------------------------------
    # Continuous features
    vm_pu = torch.tensor(bus_data["vm_pu"], dtype=torch.float32).unsqueeze(1)
    va_deg = torch.tensor(bus_data["va_degree"], dtype=torch.float32).unsqueeze(1)
    p_load = torch.tensor(bus_data["p_load_mw"], dtype=torch.float32).unsqueeze(1)
    q_load = torch.tensor(bus_data["q_load_mvar"], dtype=torch.float32).unsqueeze(1)
    p_gen = torch.tensor(bus_data["p_gen_mw"], dtype=torch.float32).unsqueeze(1)
    q_gen = torch.tensor(bus_data["q_gen_mvar"], dtype=torch.float32).unsqueeze(1)

    continuous_node_list = [vm_pu, va_deg, p_load, q_load, p_gen, q_gen]

    if include_delta:
        delta_vm = vm_pu - 1.0  # Deviation from nominal voltage
        net_p = p_gen - p_load  # Net active power injection
        net_q = q_gen - q_load  # Net reactive power injection
        continuous_node_list.extend([delta_vm, net_p, net_q])

    node_continuous = torch.cat(continuous_node_list, dim=1)

    # Categorical / binary features
    is_slack = torch.tensor(bus_data["is_slack"], dtype=torch.float32).unsqueeze(1)
    is_pv = torch.tensor(
        (bus_data["is_gen"] > 0.5) & (bus_data["is_slack"] < 0.5), dtype=torch.float32
    ).unsqueeze(1)
    is_pq = torch.tensor(
        (bus_data["is_gen"] < 0.5) & (bus_data["is_slack"] < 0.5), dtype=torch.float32
    ).unsqueeze(1)

    is_outaged_endpoint = torch.zeros((n_buses, 1), dtype=torch.float32)
    for b_idx in outaged_bus_indices:
        if b_idx < n_buses:
            is_outaged_endpoint[b_idx, 0] = 1.0

    node_categorical = torch.cat([is_pq, is_pv, is_slack, is_outaged_endpoint], dim=1)
    x = torch.cat([node_continuous, node_categorical], dim=1)

    # --------------------------------------------------------------------------
    # 2. Edge Features & Topology (Branches - Bidirectional)
    # --------------------------------------------------------------------------
    edge_src = []
    edge_dst = []
    edge_continuous_list = []
    edge_categorical_list = []

    # Process Transmission Lines
    for i in range(len(branch_data["line_id"])):
        u = bus_id_map[int(branch_data["from_bus"][i])]
        v = bus_id_map[int(branch_data["to_bus"][i])]
        r = float(branch_data["r_ohm_per_km"][i])
        x_val = float(branch_data["x_ohm_per_km"][i])
        max_i = float(branch_data["max_i_ka"][i])
        loading = float(branch_data["loading_percent"][i])
        in_svc = float(branch_data["in_service"][i])
        is_outaged_br = 1.0 if (int(branch_data["line_id"][i]) in outaged_indices and "line" in contingency_type) else 0.0

        p_f = float(branch_data["p_from_mw"][i])
        q_f = float(branch_data["q_from_mvar"][i])
        p_t = float(branch_data["p_to_mw"][i])
        q_t = float(branch_data["q_to_mvar"][i])

        margin = (100.0 * line_limit_factor) - loading if include_delta else None

        # Forward Direction: u -> v
        edge_src.append(u)
        edge_dst.append(v)
        fwd_cont = [p_f, q_f, loading, r, x_val, max_i]
        if include_delta:
            fwd_cont.append(margin)
        edge_continuous_list.append(fwd_cont)
        edge_categorical_list.append([in_svc, is_outaged_br])

        # Reverse Direction: v -> u
        edge_src.append(v)
        edge_dst.append(u)
        rev_cont = [p_t, q_t, loading, r, x_val, max_i]
        if include_delta:
            rev_cont.append(margin)
        edge_continuous_list.append(rev_cont)
        edge_categorical_list.append([in_svc, is_outaged_br])

    # Process Transformers if present
    if trafo_data is not None and len(trafo_data["trafo_id"]) > 0:
        for i in range(len(trafo_data["trafo_id"])):
            u = bus_id_map[int(trafo_data["from_bus"][i])]
            v = bus_id_map[int(trafo_data["to_bus"][i])]
            sn_mva = float(trafo_data["sn_mva"][i])
            loading = float(trafo_data["loading_percent"][i])
            in_svc = float(trafo_data["in_service"][i])
            margin = (100.0 * line_limit_factor) - loading if include_delta else None

            # Forward
            edge_src.append(u)
            edge_dst.append(v)
            fwd_cont = [0.0, 0.0, loading, 0.0, 0.05, sn_mva]
            if include_delta:
                fwd_cont.append(margin)
            edge_continuous_list.append(fwd_cont)
            edge_categorical_list.append([in_svc, 0.0])

            # Reverse
            edge_src.append(v)
            edge_dst.append(u)
            rev_cont = [0.0, 0.0, loading, 0.0, 0.05, sn_mva]
            if include_delta:
                rev_cont.append(margin)
            edge_continuous_list.append(rev_cont)
            edge_categorical_list.append([in_svc, 0.0])

    edge_index = torch.tensor([edge_src, edge_dst], dtype=torch.long)
    edge_cont_tensor = torch.tensor(edge_continuous_list, dtype=torch.float32)
    edge_cat_tensor = torch.tensor(edge_categorical_list, dtype=torch.float32)
    edge_attr = torch.cat([edge_cont_tensor, edge_cat_tensor], dim=1)

    # --------------------------------------------------------------------------
    # 3. Targets and Metadata
    # --------------------------------------------------------------------------
    y = torch.tensor([labels["cascade"]], dtype=torch.long)
    additional_trips = torch.tensor([labels["additional_trips"]], dtype=torch.long)
    load_shed_fraction = torch.tensor([labels["load_shed_fraction"]], dtype=torch.float32)
    load_shed_mw = torch.tensor([labels["load_shed_mw"]], dtype=torch.float32)

    return Data(
        x=x,
        edge_index=edge_index,
        edge_attr=edge_attr,
        y=y,
        additional_trips=additional_trips,
        load_shed_fraction=load_shed_fraction,
        load_shed_mw=load_shed_mw,
        scenario_id=scenario["scenario_id"],
        contingency_id=scenario["contingency_id"],
        contingency_type=scenario["contingency_type"],
        pre_contingency_load_mw=scenario["pre_contingency_load_mw"],
        continuous_node_dim=node_continuous.shape[1],
        continuous_edge_dim=edge_cont_tensor.shape[1]
    )


def build_pyg_dataset(
    scenarios: List[Dict[str, Any]],
    config: Dict[str, Any]
) -> List[Data]:
    """
    Build a list of PyG Data objects from all simulated scenarios.

    Args:
        scenarios (List[Dict[str, Any]]): List of raw scenario payloads.
        config (Dict[str, Any]): Configuration dictionary.

    Returns:
        List[Data]: List of PyG Data instances.
    """
    return [scenario_to_pyg_data(sc, config) for sc in scenarios]
