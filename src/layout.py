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


def compute_or_load_2d_layout(grid_case: str = "case30") -> Dict[str, Any]:
    """
    Get cached 2D topological layout per bus, or compute and cache if not present.
    Uses Kamada-Kawai or spring stress majorization, preserving aspect ratio and
    enforcing minimum node spacing. Never derives positions from voltage levels.
    """
    LAYOUT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = LAYOUT_CACHE_DIR / f"layout2d_{grid_case}.json"

    # Also check uploads directory if uploaded grid
    upload_cache = Path("data/uploads") / grid_case / "layout2d.json"
    if upload_cache.exists():
        try:
            with open(upload_cache, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # Load net
    from src.grid_manager import load_grid_by_id
    try:
        net = load_grid_by_id(grid_case)
    except Exception:
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
            G.add_edge(int(trafo.hv_bus), int(trafo.lv_bus), weight=1.2)

    # Compute 2D layout (Kamada-Kawai distance-stress layout)
    num_nodes = len(G.nodes())
    try:
        pos_2d = nx.kamada_kawai_layout(G)
    except Exception:
        k_val = 1.4 / max(np.sqrt(num_nodes), 1.0)
        pos_2d = nx.spring_layout(G, seed=42, iterations=300, k=k_val)

    # Extract coordinates
    coords = np.array([pos_2d[node] for node in sorted(G.nodes())])
    # Center coordinates
    coords -= coords.mean(axis=0)

    # Preserve aspect ratio while scaling to reasonable extent
    span_x = coords[:, 0].max() - coords[:, 0].min()
    span_z = coords[:, 1].max() - coords[:, 1].min()
    max_span = max(span_x, span_z, 1e-4)
    # Scale to [-3.2, 3.2]
    target_scale = 6.4 / max_span
    coords *= target_scale

    # Enforce minimum node spacing (overlap relaxation)
    min_dist = max(0.18, 1.8 / np.sqrt(max(num_nodes, 1)))
    node_list = sorted(G.nodes())
    for _ in range(25):
        moved = False
        for i in range(len(node_list)):
            for j in range(i + 1, len(node_list)):
                diff = coords[i] - coords[j]
                d = np.linalg.norm(diff)
                if d < min_dist and d > 1e-5:
                    push = (diff / d) * (min_dist - d) * 0.4
                    coords[i] += push
                    coords[j] -= push
                    moved = True
        if not moved:
            break

    # Determine bus roles
    ext_buses = set(net.ext_grid.bus.values) if len(net.ext_grid) > 0 else set()
    gen_buses = set(net.gen.bus.values) if len(net.gen) > 0 else set()
    load_buses = set(net.load.bus.values) if len(net.load) > 0 else set()

    bus_layout = []
    bus_map = {}

    for idx, bus_id in enumerate(node_list):
        px, pz = coords[idx]
        vn = float(net.bus.loc[bus_id, "vn_kv"]) if bus_id in net.bus.index else 132.0

        if bus_id in ext_buses:
            b_type = "slack"
        elif bus_id in gen_buses:
            b_type = "generator"
        elif bus_id in load_buses:
            b_type = "load"
        else:
            b_type = "substation"

        node_data = {
            "bus_id": int(bus_id),
            "id": int(bus_id),
            "x": round(float(px), 4),
            "y": 0.0,
            "z": round(float(pz), 4),
            "vn_kv": vn,
            "type": b_type,
            "degree": G.degree[bus_id]
        }
        bus_layout.append(node_data)
        bus_map[str(bus_id)] = node_data

    edges_data = []
    for u, v in G.edges():
        edges_data.append({
            "from_bus": int(u),
            "to_bus": int(v)
        })

    payload = {
        "grid_case": grid_case,
        "grid_id": grid_case,
        "num_buses": len(bus_layout),
        "num_branches": len(edges_data),
        "buses": bus_layout,
        "bus_map": bus_map,
        "branches": edges_data
    }

    # Save to cache
    save_path = upload_cache if ("custom_" in grid_case or upload_cache.parent.exists()) else cache_path
    try:
        save_path.parent.mkdir(parents=True, exist_ok=True)
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception:
        pass

    return payload


if __name__ == "__main__":
    l30 = compute_or_load_3d_layout("case30")
    print(f"Generated case30 layout: {len(l30['buses'])} buses")
    l30_2d = compute_or_load_2d_layout("case30")
    print(f"Generated case30 2D layout: {len(l30_2d['buses'])} buses")

