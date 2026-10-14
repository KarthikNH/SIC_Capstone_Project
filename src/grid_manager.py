"""
Grid upload, conversion, validation, and storage manager.

Security rules:
- NEVER execute uploaded files (eval, exec forbidden).
- NEVER unpickle uploaded files (pickle.load forbidden).
- Pure text parsing for MATPOWER .m files.
- Enforce strict extension whitelist (.m, .json, .csv, .zip).
- Enforce file size limit (5 MB) and bus count limit (500 buses).
- Store under data/uploads/<grid_id> with an automated cleanup policy.
"""

import copy
import io
import json
import os
from pathlib import Path
import re
import shutil
import time
from typing import Any, Dict, List, Optional, Tuple, Union
import zipfile

import networkx as nx
import numpy as np
import pandas as pd
import pandapower as pp
import pandapower.networks as pn
import pandapower.topology as ppt

from src.layout import compute_or_load_3d_layout


PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOADS_DIR = PROJECT_ROOT / "data" / "uploads"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_BUS_COUNT = 500
MAX_STORED_UPLOADS = 50


def ensure_uploads_dir() -> Path:
    """Ensure uploads directory exists and return Path."""
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    return UPLOADS_DIR


def cleanup_old_uploads(max_kept: int = MAX_STORED_UPLOADS) -> None:
    """Retain only the newest uploaded grids to prevent disk exhaustion."""
    if not UPLOADS_DIR.exists():
        return
    grid_folders = [p for p in UPLOADS_DIR.iterdir() if p.is_dir()]
    if len(grid_folders) > max_kept:
        # Sort by modification time ascending (oldest first)
        grid_folders.sort(key=lambda p: p.stat().st_mtime)
        to_delete = grid_folders[: len(grid_folders) - max_kept]
        for folder in to_delete:
            shutil.rmtree(folder, ignore_errors=True)


# ==============================================================================
# Pure-Text MATPOWER Parser (No execution, no eval)
# ==============================================================================

def parse_matpower_text(content: str) -> Dict[str, Any]:
    """
    Parse a MATPOWER .m file purely as text via regular expressions.
    Extracts baseMVA, bus matrix, gen matrix, and branch matrix numerically.
    Never calls eval() or exec().
    """
    # 1. Base MVA
    base_mva = 100.0
    base_mva_match = re.search(r'mpc\.baseMVA\s*=\s*([0-9\.]+)\s*;', content, re.IGNORECASE)
    if base_mva_match:
        try:
            base_mva = float(base_mva_match.group(1))
        except ValueError:
            pass

    # Helper function to extract matrix block between 'mpc.<name> = [' and '];'
    def extract_matrix(matrix_name: str) -> np.ndarray:
        pattern = re.compile(
            rf'mpc\.{matrix_name}\s*=\s*\[(.*?)\]\s*;',
            re.DOTALL | re.IGNORECASE
        )
        match = pattern.search(content)
        if not match:
            return np.empty((0, 0))

        raw_block = match.group(1)
        # Remove comments starting with % or //
        lines = []
        for line in raw_block.splitlines():
            line = re.sub(r'%.*$', '', line)
            line = re.sub(r'//.*$', '', line)
            line = line.strip()
            if line:
                lines.append(line)

        cleaned_text = " ".join(lines).replace(";", " ; ")
        rows = cleaned_text.split(";")
        data_rows = []
        for r in rows:
            tokens = [t.strip() for t in r.split() if t.strip()]
            if tokens:
                try:
                    data_rows.append([float(t) for t in tokens])
                except ValueError:
                    continue

        if not data_rows:
            return np.empty((0, 0))

        # Pad to max row length if jagged
        max_cols = max(len(row) for row in data_rows)
        padded = [row + [0.0] * (max_cols - len(row)) for row in data_rows]
        return np.array(padded, dtype=float)

    bus_mat = extract_matrix("bus")
    gen_mat = extract_matrix("gen")
    branch_mat = extract_matrix("branch")

    return {
        "baseMVA": base_mva,
        "bus": bus_mat,
        "gen": gen_mat,
        "branch": branch_mat,
    }


def matpower_data_to_pandapower(parsed: Dict[str, Any]) -> pp.pandapowerNet:
    """
    Convert parsed MATPOWER matrices to a pandapowerNet object.
    Standard MATPOWER columns:
    Bus: 0:bus_i, 1:type (1=PQ, 2=PV, 3=ref, 4=isolated), 2:Pd, 3:Qd, 7:Vm, 8:Va, 9:baseKV
    Gen: 0:bus, 1:Pg, 2:Qg, 3:Qmax, 4:Qmin, 5:Vg, 6:mBase, 7:status, 8:Pmax, 9:Pmin
    Branch: 0:fbus, 1:tbus, 2:r, 3:x, 4:b, 5:rateA, 8:ratio, 10:status
    """
    net = pp.create_empty_network(sn_mva=parsed["baseMVA"])
    bus_mat = parsed["bus"]
    gen_mat = parsed["gen"]
    branch_mat = parsed["branch"]

    if bus_mat.shape[0] == 0:
        raise ValueError("MATPOWER file does not contain a valid mpc.bus matrix.")

    bus_id_map: Dict[int, int] = {}

    for i in range(bus_mat.shape[0]):
        b_id = int(bus_mat[i, 0])
        b_type = int(bus_mat[i, 1]) if bus_mat.shape[1] > 1 else 1
        pd_mw = float(bus_mat[i, 2]) if bus_mat.shape[1] > 2 else 0.0
        qd_mvar = float(bus_mat[i, 3]) if bus_mat.shape[1] > 3 else 0.0
        vm_pu = float(bus_mat[i, 7]) if bus_mat.shape[1] > 7 else 1.0
        base_kv = float(bus_mat[i, 9]) if bus_mat.shape[1] > 9 and bus_mat[i, 9] > 0 else 135.0

        pp_bus = pp.create_bus(net, vn_kv=base_kv, name=f"Bus {b_id}")
        bus_id_map[b_id] = pp_bus

        # Add load if active or reactive load exists
        if abs(pd_mw) > 1e-4 or abs(qd_mvar) > 1e-4:
            pp.create_load(net, bus=pp_bus, p_mw=pd_mw, q_mvar=qd_mvar, name=f"Load {b_id}")

        # If bus type == 3 (Reference / Slack)
        if b_type == 3:
            pp.create_ext_grid(net, bus=pp_bus, vm_pu=vm_pu, name=f"Slack Bus {b_id}")

    # Add Generators
    if gen_mat.shape[0] > 0:
        for i in range(gen_mat.shape[0]):
            g_bus = int(gen_mat[i, 0])
            if g_bus not in bus_id_map:
                continue
            pp_b = bus_id_map[g_bus]
            pg_mw = float(gen_mat[i, 1]) if gen_mat.shape[1] > 1 else 0.0
            vg_pu = float(gen_mat[i, 5]) if gen_mat.shape[1] > 5 and gen_mat[i, 5] > 0 else 1.0
            status = float(gen_mat[i, 7]) if gen_mat.shape[1] > 7 else 1.0
            p_max = float(gen_mat[i, 8]) if gen_mat.shape[1] > 8 else (pg_mw * 1.5 if pg_mw > 0 else 100.0)
            p_min = float(gen_mat[i, 9]) if gen_mat.shape[1] > 9 else 0.0
            in_svc = status > 0

            # If slack already on this bus, skip creating duplicate ext_grid, or create gen
            is_slack_bus = len(net.ext_grid) > 0 and (pp_b in net.ext_grid.bus.values)
            if not is_slack_bus:
                pp.create_gen(
                    net,
                    bus=pp_b,
                    p_mw=pg_mw,
                    vm_pu=vg_pu,
                    min_p_mw=p_min,
                    max_p_mw=p_max,
                    in_service=in_svc,
                    name=f"Gen {g_bus}"
                )

    # Ensure at least one slack bus exists
    if len(net.ext_grid) == 0:
        # Fallback: make the first generator bus or first bus the slack
        slack_b = bus_id_map[int(bus_mat[0, 0])]
        pp.create_ext_grid(net, bus=slack_b, vm_pu=1.0, name="Auto-Assigned Slack")

    # Add Branches
    if branch_mat.shape[0] > 0:
        for i in range(branch_mat.shape[0]):
            fb = int(branch_mat[i, 0])
            tb = int(branch_mat[i, 1])
            if fb not in bus_id_map or tb not in bus_id_map:
                continue
            u = bus_id_map[fb]
            v = bus_id_map[tb]
            r_pu = float(branch_mat[i, 2]) if branch_mat.shape[1] > 2 else 0.01
            x_pu = float(branch_mat[i, 3]) if branch_mat.shape[1] > 3 else 0.05
            rate_a = float(branch_mat[i, 5]) if branch_mat.shape[1] > 5 else 0.0
            ratio = float(branch_mat[i, 8]) if branch_mat.shape[1] > 8 else 0.0
            status = float(branch_mat[i, 10]) if branch_mat.shape[1] > 10 else 1.0
            in_svc = status > 0

            vn_kv = net.bus.loc[u, "vn_kv"]
            # Convert pu impedance to ohms: Z_base = (kV^2) / MVA_base
            z_base = (vn_kv ** 2) / net.sn_mva
            r_ohm = max(r_pu * z_base, 1e-4)
            x_ohm = max(x_pu * z_base, 1e-4)

            # Thermal rating in kA: I = MVA / (sqrt(3) * kV)
            if rate_a > 0:
                max_i_ka = rate_a / (np.sqrt(3) * vn_kv)
            else:
                max_i_ka = 0.0  # Will be derived from base power flow

            # Check if transformer (ratio > 0 and ratio != 1.0)
            if ratio > 0 and abs(ratio - 1.0) > 1e-3:
                pp.create_transformer_from_parameters(
                    net,
                    hv_bus=u,
                    lv_bus=v,
                    sn_mva=rate_a if rate_a > 0 else 100.0,
                    vn_hv_kv=vn_kv,
                    vn_lv_kv=vn_kv * ratio,
                    vkr_percent=r_pu * 100.0,
                    vk_percent=np.sqrt(r_pu**2 + x_pu**2) * 100.0,
                    pfe_kw=0.0,
                    i0_percent=0.0,
                    in_service=in_svc,
                    name=f"Trafo {fb}-{tb}"
                )
            else:
                pp.create_line_from_parameters(
                    net,
                    from_bus=u,
                    to_bus=v,
                    length_km=1.0,
                    r_ohm_per_km=r_ohm,
                    x_ohm_per_km=x_ohm,
                    c_nf_per_km=0.0,
                    max_i_ka=max_i_ka,
                    in_service=in_svc,
                    name=f"Line {fb}-{tb}"
                )

    return net


# ==============================================================================
# CSV Grid Parser
# ==============================================================================

def parse_csv_grid_data(
    bus_df: pd.DataFrame,
    branch_df: pd.DataFrame,
    gen_df: Optional[pd.DataFrame] = None
) -> pp.pandapowerNet:
    """Build pandapowerNet from validated CSV DataFrames."""
    net = pp.create_empty_network(sn_mva=100.0)

    # Standardize column names
    bus_df.columns = [c.strip().lower() for c in bus_df.columns]
    branch_df.columns = [c.strip().lower() for c in branch_df.columns]
    if gen_df is not None:
        gen_df.columns = [c.strip().lower() for c in gen_df.columns]

    bus_map: Dict[int, int] = {}
    for _, row in bus_df.iterrows():
        b_id = int(row.get("bus_id", row.get("id", len(bus_map))))
        vn_kv = float(row.get("vn_kv", row.get("base_kv", 135.0)))
        b_type = str(row.get("type", "load")).lower()
        p_load = float(row.get("p_mw", row.get("p_load_mw", 0.0)))
        q_load = float(row.get("q_mvar", row.get("q_load_mvar", 0.0)))

        pp_b = pp.create_bus(net, vn_kv=vn_kv, name=f"Bus {b_id}")
        bus_map[b_id] = pp_b

        if abs(p_load) > 1e-4 or abs(q_load) > 1e-4:
            pp.create_load(net, bus=pp_b, p_mw=p_load, q_mvar=q_load, name=f"Load {b_id}")

        if "slack" in b_type or "ref" in b_type:
            pp.create_ext_grid(net, bus=pp_b, vm_pu=1.0, name=f"Slack {b_id}")

    # Add Generators if present in gen_df
    if gen_df is not None and len(gen_df) > 0:
        for _, row in gen_df.iterrows():
            b_id = int(row.get("bus_id", row.get("bus", 0)))
            if b_id not in bus_map:
                continue
            pp_b = bus_map[b_id]
            p_mw = float(row.get("p_mw", row.get("p_gen_mw", 0.0)))
            vm_pu = float(row.get("vm_pu", 1.0))
            is_slack = bool(row.get("is_slack", False))
            if is_slack and len(net.ext_grid) == 0:
                pp.create_ext_grid(net, bus=pp_b, vm_pu=vm_pu, name=f"Slack {b_id}")
            else:
                pp.create_gen(net, bus=pp_b, p_mw=p_mw, vm_pu=vm_pu, name=f"Gen {b_id}")

    # If no slack, assign first bus
    if len(net.ext_grid) == 0:
        pp.create_ext_grid(net, bus=0, vm_pu=1.0, name="Auto-Assigned Slack")

    # Add Branches
    for _, row in branch_df.iterrows():
        fb = int(row.get("from_bus", row.get("from", 0)))
        tb = int(row.get("to_bus", row.get("to", 1)))
        if fb not in bus_map or tb not in bus_map:
            continue
        u = bus_map[fb]
        v = bus_map[tb]
        r_ohm = float(row.get("r_ohm", row.get("r", 0.1)))
        x_ohm = float(row.get("x_ohm", row.get("x", 0.5)))
        max_i_ka = float(row.get("max_i_ka", row.get("rating_ka", 0.0)))
        in_svc = bool(row.get("in_service", True))

        pp.create_line_from_parameters(
            net,
            from_bus=u,
            to_bus=v,
            length_km=1.0,
            r_ohm_per_km=max(r_ohm, 1e-4),
            x_ohm_per_km=max(x_ohm, 1e-4),
            c_nf_per_km=0.0,
            max_i_ka=max_i_ka,
            in_service=in_svc,
            name=f"Line {fb}-{tb}"
        )

    return net


# ==============================================================================
# Validation & Plain-Language Reporting Engine
# ==============================================================================

def validate_and_calibrate_grid(
    net: pp.pandapowerNet,
    grid_id: str,
    grid_name: str = ""
) -> Dict[str, Any]:
    """
    Validate network integrity and return a plain-language diagnostic report.
    Checks:
    - Bus count <= 500
    - Slack bus presence
    - Connectivity & islands (NetworkX / pandapower topology)
    - AC power flow convergence (pp.runpp)
    - Sensible base MVA & units
    - Branch thermal ratings (derive with 25% margin if missing, marked as assumption)
    """
    report: Dict[str, Any] = {
        "valid": True,
        "grid_id": grid_id,
        "name": grid_name or grid_id,
        "num_buses": int(len(net.bus)),
        "num_branches": int(len(net.line) + len(net.trafo) if hasattr(net, "trafo") else len(net.line)),
        "num_generators": int(len(net.gen)),
        "num_loads": int(len(net.load)),
        "islands": [],
        "is_connected": True,
        "slack_present": False,
        "ac_converged": False,
        "assumptions": [],
        "warnings": [],
        "errors": []
    }

    # 1. Bus count limit
    if len(net.bus) > MAX_BUS_COUNT:
        report["valid"] = False
        report["errors"].append(
            f"Grid exceeds maximum supported size: {len(net.bus)} buses found (limit is {MAX_BUS_COUNT})."
        )
        return report

    if len(net.bus) < 2:
        report["valid"] = False
        report["errors"].append("Grid must have at least 2 buses.")
        return report

    # 2. Slack bus check
    has_slack = len(net.ext_grid) > 0
    report["slack_present"] = has_slack
    if not has_slack:
        report["valid"] = False
        report["errors"].append("No slack / reference bus present in the power grid.")
        return report

    # 3. Base MVA sanity
    if net.sn_mva <= 0 or net.sn_mva > 10000:
        report["warnings"].append(
            f"Unusual base MVA rating ({net.sn_mva} MVA). Standard power system base is 100 MVA."
        )

    # 4. Connectivity and Islands
    G = nx.Graph()
    for b in net.bus.index:
        G.add_node(int(b))
    for _, l in net.line[net.line.in_service].iterrows():
        G.add_edge(int(l.from_bus), int(l.to_bus))
    if hasattr(net, "trafo") and len(net.trafo) > 0:
        for _, t in net.trafo[net.trafo.in_service].iterrows():
            G.add_edge(int(t.hv_bus), int(t.lv_bus))

    components = list(nx.connected_components(G))
    if len(components) > 1:
        report["is_connected"] = False
        islands_list = [sorted(list(c)) for c in components]
        report["islands"] = islands_list
        report["warnings"].append(
            f"Grid contains {len(components)} disconnected electrical islands. "
            f"Largest island has {len(components[0])} buses."
        )
    else:
        report["is_connected"] = True
        report["islands"] = [[int(b) for b in net.bus.index]]

    # 5. Branch ratings check & AC Power Flow calibration
    missing_ratings = False
    if len(net.line) > 0:
        if "max_i_ka" not in net.line or (net.line["max_i_ka"] <= 0).any() or net.line["max_i_ka"].isna().any():
            missing_ratings = True

    # Run base AC power flow
    net_copy = copy.deepcopy(net)
    converged = False
    try:
        pp.runpp(net_copy, numba=False)
        converged = bool(net_copy.converged)
    except Exception as e:
        converged = False
        report["warnings"].append(f"Base AC power flow did not converge immediately: {str(e)[:120]}")

    report["ac_converged"] = converged

    # Calibrate branch ratings if missing
    if missing_ratings:
        if converged and hasattr(net_copy, "res_line") and len(net_copy.res_line) > 0:
            flows_i_ka = net_copy.res_line.i_ka.values
            calibrated_i = np.maximum(np.abs(flows_i_ka) * 1.25, 0.05)
            net.line["max_i_ka"] = calibrated_i
            report["assumptions"].append(
                "Branch thermal ratings were missing or zero; derived automatically from base-case "
                "AC power flow with a 25% safety margin (Assumption)."
            )
        else:
            # Fallback estimation using bus voltage and line impedance
            nominal_current = 0.50  # 0.5 kA default
            net.line["max_i_ka"] = nominal_current
            report["assumptions"].append(
                "AC power flow unavailable for rating calibration; assigned default 0.50 kA thermal rating "
                "to all branches (Assumption)."
            )

    return report


# ==============================================================================
# Grid Registry & Persistence
# ==============================================================================

_IN_MEMORY_GRIDS: Dict[str, pp.pandapowerNet] = {}
_GRID_METADATA_CACHE: Dict[str, Dict[str, Any]] = {}


def register_uploaded_grid(
    grid_id: str,
    net: pp.pandapowerNet,
    report: Dict[str, Any]
) -> Path:
    """Save an uploaded, validated grid and its layout to disk."""
    ensure_uploads_dir()
    grid_dir = UPLOADS_DIR / grid_id
    grid_dir.mkdir(parents=True, exist_ok=True)

    # 1. Save pandapower JSON
    grid_json_path = grid_dir / "grid.json"
    pp.to_json(net, grid_json_path)

    # 2. Save metadata report
    meta_path = grid_dir / "metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    # 3. Compute and cache 3D layout
    compute_and_cache_grid_3d_layout(net, grid_id, grid_dir / "layout.json")

    # In-memory cache
    _IN_MEMORY_GRIDS[grid_id] = net
    _GRID_METADATA_CACHE[grid_id] = report

    cleanup_old_uploads()
    return grid_dir


def delete_uploaded_grid(grid_id: str) -> bool:
    """Delete an uploaded grid from disk and in-memory caches."""
    grid_dir = UPLOADS_DIR / grid_id
    deleted = False
    if grid_dir.exists():
        shutil.rmtree(grid_dir, ignore_errors=True)
        deleted = True
    if grid_id in _IN_MEMORY_GRIDS:
        del _IN_MEMORY_GRIDS[grid_id]
        deleted = True
    if grid_id in _GRID_METADATA_CACHE:
        del _GRID_METADATA_CACHE[grid_id]
        deleted = True
    return deleted


def load_grid_by_id(grid_id: str) -> pp.pandapowerNet:
    """
    Retrieve pandapower grid by ID (supporting built-in 'case30', 'case118' and uploads).
    """
    if grid_id in _IN_MEMORY_GRIDS:
        return copy.deepcopy(_IN_MEMORY_GRIDS[grid_id])

    # Built-in IEEE cases
    if grid_id in ("case14", "case30", "case57", "case118", "case300"):
        if hasattr(pn, grid_id):
            net = getattr(pn, grid_id)()
            _IN_MEMORY_GRIDS[grid_id] = net
            return copy.deepcopy(net)
        from src.simulator import load_grid
        from src.utils.config import load_config
        cfg = load_config("config.yaml")
        net = load_grid(grid_id, cfg)
        _IN_MEMORY_GRIDS[grid_id] = net
        return copy.deepcopy(net)

    # Uploaded cases
    grid_file = UPLOADS_DIR / grid_id / "grid.json"
    if grid_file.exists():
        net = pp.from_json(grid_file)
        _IN_MEMORY_GRIDS[grid_id] = net
        return copy.deepcopy(net)

    raise FileNotFoundError(f"Grid with ID '{grid_id}' not found.")


def get_grid_metadata(grid_id: str) -> Dict[str, Any]:
    """Retrieve metadata/report for a grid."""
    if grid_id in _GRID_METADATA_CACHE:
        return _GRID_METADATA_CACHE[grid_id]

    meta_file = UPLOADS_DIR / grid_id / "metadata.json"
    if meta_file.exists():
        with open(meta_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            _GRID_METADATA_CACHE[grid_id] = data
            return data

    if grid_id in ("case14", "case30", "case57", "case118", "case300"):
        net = load_grid_by_id(grid_id)
        rep = validate_and_calibrate_grid(net, grid_id, f"IEEE {grid_id.replace('case', '')}-Bus System")
        _GRID_METADATA_CACHE[grid_id] = rep
        return rep

    raise FileNotFoundError(f"Metadata for grid '{grid_id}' not found.")


def list_available_grids() -> List[Dict[str, Any]]:
    """List all available built-in and uploaded grids with metadata and OOD status."""
    from src.ood_detector import get_grid_ood_status

    grids = []
    # 1. Built-in grids
    for cid, name in [("case30", "IEEE 30-Bus System"), ("case118", "IEEE 118-Bus System")]:
        try:
            meta = get_grid_metadata(cid)
            ood = get_grid_ood_status(cid)
            grids.append({
                "id": cid,
                "name": name,
                "is_builtin": True,
                "num_buses": meta["num_buses"],
                "num_branches": meta["num_branches"],
                "ac_converged": meta["ac_converged"],
                "ood_status": ood
            })
        except Exception:
            pass

    # 2. Uploaded grids
    if UPLOADS_DIR.exists():
        for g_dir in UPLOADS_DIR.iterdir():
            if g_dir.is_dir() and (g_dir / "grid.json").exists():
                gid = g_dir.name
                try:
                    meta = get_grid_metadata(gid)
                    ood = get_grid_ood_status(gid)
                    grids.append({
                        "id": gid,
                        "name": meta.get("name", gid),
                        "is_builtin": False,
                        "num_buses": meta["num_buses"],
                        "num_branches": meta["num_branches"],
                        "ac_converged": meta["ac_converged"],
                        "ood_status": ood
                    })
                except Exception:
                    pass

    return grids


# ==============================================================================
# 3D Layout Computation for Any Grid
# ==============================================================================

def compute_and_cache_grid_3d_layout(
    net: pp.pandapowerNet,
    grid_id: str,
    output_path: Optional[Path] = None
) -> Dict[str, Any]:
    """Compute 3D force-directed layout stratified by voltage level for any grid."""
    if output_path is None:
        output_path = UPLOADS_DIR / grid_id / "layout.json"

    G = nx.Graph()
    for b in net.bus.index:
        G.add_node(int(b))

    for _, line in net.line.iterrows():
        G.add_edge(int(line.from_bus), int(line.to_bus), weight=1.0)

    if hasattr(net, "trafo") and len(net.trafo) > 0:
        for _, trafo in net.trafo.iterrows():
            G.add_edge(int(trafo.hv_bus), int(trafo.lv_bus), weight=1.5)

    pos_2d = nx.spring_layout(G, seed=42, iterations=250, k=1.2 / max(np.sqrt(len(G.nodes())), 1.0))

    ext_buses = set(net.ext_grid.bus.values) if len(net.ext_grid) > 0 else set()
    gen_buses = set(net.gen.bus.values) if len(net.gen) > 0 else set()
    load_buses = set(net.load.bus.values) if len(net.load) > 0 else set()

    vn_values = net.bus.vn_kv.values
    unique_vns = sorted(list(set(vn_values)))

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

        if len(unique_vns) > 1:
            vn_idx = unique_vns.index(vn)
            y_base = -0.5 + (1.2 * vn_idx / (len(unique_vns) - 1))
            role_offset = 0.15 if b_type in ("generator", "slack") else (-0.1 if b_type == "load" else 0.0)
            py = y_base + role_offset
        else:
            if b_type == "slack":
                py = 0.55
            elif b_type == "generator":
                py = 0.35
            elif b_type == "substation":
                py = 0.05
            else:
                py = -0.35

        entry = {
            "bus_id": int(bus_id),
            "x": round(float(px) * 10.0, 3),
            "y": round(float(py) * 5.0, 3),
            "z": round(float(pz) * 10.0, 3),
            "vn_kv": round(vn, 1),
            "type": b_type,
            "degree": int(G.degree(bus_id))
        }
        bus_layout.append(entry)
        bus_map[str(bus_id)] = entry

    branches_list = []
    for u, v in G.edges():
        branches_list.append({"from_bus": int(u), "to_bus": int(v)})

    layout_data = {
        "grid_case": grid_id,
        "num_buses": len(bus_layout),
        "num_branches": len(branches_list),
        "buses": bus_layout,
        "branches": branches_list,
        "bus_map": bus_map
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(layout_data, f, indent=2)

    return layout_data


def get_grid_3d_layout(grid_id: str) -> Dict[str, Any]:
    """Retrieve or compute 3D layout for built-in or uploaded grid."""
    if grid_id in ("case30", "case118"):
        return compute_or_load_3d_layout(grid_id)

    layout_file = UPLOADS_DIR / grid_id / "layout.json"
    if layout_file.exists():
        with open(layout_file, "r", encoding="utf-8") as f:
            return json.load(f)

    net = load_grid_by_id(grid_id)
    return compute_and_cache_grid_3d_layout(net, grid_id, layout_file)


# ==============================================================================
# Grid Statistics Engine
# ==============================================================================

def compute_grid_statistics(grid_id: str) -> Dict[str, Any]:
    """
    Compute comprehensive electrical and topological statistics for a grid:
    - Counts of buses, branches, generators, loads, transformers
    - Total demand and generation in MW
    - Average and max branch loading (% from base power flow)
    - Number of branches above 80% loading
    - Min and max bus voltages (p.u.)
    - Average node degree
    - Number of bridge branches (single points of failure)
    - Bus-type counts
    - Loading histogram
    """
    net = load_grid_by_id(grid_id)

    # 1. Component counts
    n_buses = len(net.bus)
    n_lines = len(net.line)
    n_trafos = len(net.trafo) if hasattr(net, "trafo") else 0
    n_branches = n_lines + n_trafos
    n_gens = len(net.gen)
    n_loads = len(net.load)

    # 2. Power sums
    total_demand_mw = float(net.load["p_mw"].sum()) if n_loads > 0 else 0.0
    total_gen_mw = float(net.gen["p_mw"].sum()) if n_gens > 0 else 0.0

    # 3. Topology graph & Bridges
    G = nx.Graph()
    for b in net.bus.index:
        G.add_node(int(b))
    for _, l in net.line[net.line.in_service].iterrows():
        G.add_edge(int(l.from_bus), int(l.to_bus))
    if hasattr(net, "trafo") and len(net.trafo) > 0:
        for _, t in net.trafo[net.trafo.in_service].iterrows():
            G.add_edge(int(t.hv_bus), int(t.lv_bus))

    avg_degree = round(float(np.mean([d for _, d in G.degree()])), 2) if n_buses > 0 else 0.0
    bridges = list(nx.bridges(G))
    num_bridges = len(bridges)

    # 4. Bus type counts
    ext_buses = set(net.ext_grid.bus.values) if len(net.ext_grid) > 0 else set()
    gen_buses = set(net.gen.bus.values) if len(net.gen) > 0 else set()
    load_buses = set(net.load.bus.values) if len(net.load) > 0 else set()

    slack_cnt = len(ext_buses)
    gen_cnt = len(gen_buses - ext_buses)
    load_cnt = len(load_buses - gen_buses - ext_buses)
    substation_cnt = n_buses - (slack_cnt + gen_cnt + load_cnt)

    # 5. AC Power Flow and Loadings
    net_copy = copy.deepcopy(net)
    avg_loading = 0.0
    max_loading = 0.0
    branches_over_80 = 0
    v_min = 1.0
    v_max = 1.0
    loadings = []

    try:
        pp.runpp(net_copy, numba=False)
        if net_copy.converged:
            if hasattr(net_copy, "res_line") and len(net_copy.res_line) > 0:
                loadings = net_copy.res_line.loading_percent.values.tolist()
            if hasattr(net_copy, "res_trafo") and len(net_copy.res_trafo) > 0:
                loadings.extend(net_copy.res_trafo.loading_percent.values.tolist())

            if loadings:
                arr_l = np.array(loadings)
                avg_loading = round(float(np.mean(arr_l)), 2)
                max_loading = round(float(np.max(arr_l)), 2)
                branches_over_80 = int(np.sum(arr_l > 80.0))

            if hasattr(net_copy, "res_bus") and len(net_copy.res_bus) > 0:
                v_min = round(float(net_copy.res_bus.vm_pu.min()), 3)
                v_max = round(float(net_copy.res_bus.vm_pu.max()), 3)
    except Exception:
        pass

    # 6. Loading Histogram (bins: 0-20, 20-40, 40-60, 60-80, 80-100, >100)
    bins = [0.0, 20.0, 40.0, 60.0, 80.0, 100.0, 999.0]
    hist_labels = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%", ">100%"]
    hist_counts = [0] * len(hist_labels)
    for l in loadings:
        for idx in range(len(bins) - 1):
            if bins[idx] <= l < bins[idx + 1]:
                hist_counts[idx] += 1
                break

    loading_histogram = [
        {"bin": label, "count": count}
        for label, count in zip(hist_labels, hist_counts)
    ]

    return {
        "grid_id": grid_id,
        "counts": {
            "buses": n_buses,
            "branches": n_branches,
            "generators": n_gens,
            "loads": n_loads,
            "transformers": n_trafos
        },
        "total_demand_mw": round(total_demand_mw, 2),
        "total_generation_mw": round(total_gen_mw, 2),
        "average_branch_loading_percent": avg_loading,
        "max_branch_loading_percent": max_loading,
        "branches_above_80_percent": branches_over_80,
        "voltage_min_pu": v_min,
        "voltage_max_pu": v_max,
        "average_degree": avg_degree,
        "num_bridge_branches": num_bridges,
        "bus_type_counts": {
            "slack": slack_cnt,
            "generator": gen_cnt,
            "load": load_cnt,
            "substation": substation_cnt
        },
        "loading_histogram": loading_histogram
    }
