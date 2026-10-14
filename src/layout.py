"""
3D Layout Generation for Power Grid Networks.

Computes 3D coordinates per bus using force-directed layout for planar spread (x, z)
and vertical layering (y) by voltage level and electrical bus role.
Caches coordinates to JSON on disk for instant retrieval by frontend visualizers.
"""

import json
from pathlib import Path
from typing import Any, Dict, List
import networkx as nx
import numpy as np
import pandapower as pp
import pandapower.networks as pn


LAYOUT_CACHE_DIR = Path("data/processed")


def compute_or_load_3d_layout(grid_case: str = "case30") -> Dict[str, Any]:
    """
    Get cached 3D coordinates per bus, or compute and cache if not present.

    Args:
        grid_case (str): 'case30' or 'case118'.

    Returns:
        Dict[str, Any]: Layout metadata and dictionary of bus positions {bus_id: {x, y, z, ...}}.
    """
    LAYOUT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = LAYOUT_CACHE_DIR / f"layout_{grid_case}.json"

    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Compute 3D layout
    if hasattr(pn, grid_case):
        net = getattr(pn, grid_case)()
    else:
        net = pn.case30()

    # Build networkx graph
    G = nx.Graph()
    for bus_id in net.bus.index:
        G.add_node(int(bus_id))

    for _, line in net.line.iterrows():
        G.add_edge(int(line.from_bus), int(line.to_bus), weight=1.0)

    if hasattr(net, "trafo") and len(net.trafo) > 0:
        for _, trafo in net.trafo.iterrows():
            G.add_edge(int(trafo.hv_bus), int(trafo.lv_bus), weight=1.5)

    # 2D force-directed planar layout for (x, z)
    # Using spring layout with fixed seed for determinism
    pos_2d = nx.spring_layout(G, seed=42, iterations=250, k=1.2 / np.sqrt(len(G.nodes())))

    # Determine bus roles
    ext_buses = set(net.ext_grid.bus.values) if len(net.ext_grid) > 0 else set()
    gen_buses = set(net.gen.bus.values) if len(net.gen) > 0 else set()
    load_buses = set(net.load.bus.values) if len(net.load) > 0 else set()

    vn_values = net.bus.vn_kv.values
    unique_vns = sorted(list(set(vn_values)))

    # Compute vertical Y coordinate based on voltage level layering
    bus_layout = []
    bus_map = {}

    for bus_id in sorted(G.nodes()):
        px, pz = pos_2d[bus_id]
        vn = float(net.bus.loc[bus_id, "vn_kv"])

        if bus_id in ext_buses:
            b_type = "slack"
        elif bus_id in gen_buses:
            b_type = "generator"
        elif bus_id in load_buses:
            b_type = "load"
        else:
            b_type = "substation"

        # Multi-voltage hierarchy (e.g. 118-bus: 138kV, 161kV, 345kV)
        if len(unique_vns) > 1:
            vn_idx = unique_vns.index(vn)
            y_base = -0.5 + (1.2 * vn_idx / (len(unique_vns) - 1))
            # Minor role offset
            role_offset = 0.15 if b_type in ("generator", "slack") else (-0.1 if b_type == "load" else 0.0)
            py = y_base + role_offset
        else:
            # Single-voltage hierarchy (e.g. 30-bus: 135kV)
            # Layer by generator (higher), substation (mid), load (lower)
            if b_type == "slack":
                py = 0.55
            elif b_type == "generator":
                py = 0.35
            elif b_type == "substation":
                py = 0.05
            else:
                # Load bus: small sinusoidal variation by node id for pleasant 3D depth
                py = -0.30 + 0.15 * np.sin(bus_id * 0.7)

        node_data = {
            "bus_id": int(bus_id),
            "x": round(float(px * 1.6), 4),
            "y": round(float(py), 4),
            "z": round(float(pz * 1.6), 4),
            "vn_kv": vn,
            "type": b_type,
            "degree": G.degree[bus_id]
        }
        bus_layout.append(node_data)
        bus_map[str(bus_id)] = node_data

    # Center and scale edges for fast 3D line drawing
    edges_data = []
    for u, v in G.edges():
        edges_data.append({
            "from_bus": int(u),
            "to_bus": int(v)
        })

    payload = {
        "grid_case": grid_case,
        "num_buses": len(bus_layout),
        "num_branches": len(edges_data),
        "buses": bus_layout,
        "bus_map": bus_map,
        "branches": edges_data
    }

    # Cache to disk
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return payload


if __name__ == "__main__":
    # Test generation for both cases
    l30 = compute_or_load_3d_layout("case30")
    print(f"Generated case30 layout: {len(l30['buses'])} buses, cached to {LAYOUT_CACHE_DIR / 'layout_case30.json'}")
    l118 = compute_or_load_3d_layout("case118")
    print(f"Generated case118 layout: {len(l118['buses'])} buses, cached to {LAYOUT_CACHE_DIR / 'layout_case118.json'}")
