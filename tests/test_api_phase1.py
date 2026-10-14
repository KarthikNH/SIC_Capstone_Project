"""
Integration and regression test suite for Phase 1 backend upgrades:
1. Grid upload: MATPOWER .m (IEEE 57-bus non-training case), CSVs, pandapower JSON.
2. Security: file size limit (5MB), bus limit (500), broken files.
3. Out-of-distribution (OOD) badge and reason validation.
4. Grid statistics and 3D layout endpoints.
5. Upgraded /predict endpoint with before/after delta, second_opinion, narrative, feature groups.
6. What-if risk curve endpoint.
7. Criticality screening map and polling endpoint.
8. Calibration stub (501).
"""

import io
import json
from pathlib import Path
import time
import pytest
import requests
import pandapower.networks as pn


BASE_URL = "http://127.0.0.1:8000"


def generate_matpower_case57_text() -> str:
    """Generate MATPOWER .m format text for IEEE 57-bus system using pandapower."""
    net57 = pn.case57()
    m_lines = [
        "function mpc = case57",
        "mpc.version = '2';",
        f"mpc.baseMVA = {float(net57.sn_mva)};\n",
        "%% bus data: bus_i type Pd Qd Gs Bs area Vm Va baseKV zone Vmax Vmin",
        "mpc.bus = ["
    ]

    ext_buses = set(net57.ext_grid.bus.values) if len(net57.ext_grid) > 0 else set()
    gen_buses = set(net57.gen.bus.values) if len(net57.gen) > 0 else set()

    for idx, row in net57.bus.iterrows():
        b_i = int(idx) + 1
        if idx in ext_buses:
            b_type = 3
        elif idx in gen_buses:
            b_type = 2
        else:
            b_type = 1

        p_loads = net57.load[net57.load.bus == idx]["p_mw"].sum() if len(net57.load) > 0 else 0.0
        q_loads = net57.load[net57.load.bus == idx]["q_mvar"].sum() if len(net57.load) > 0 else 0.0
        m_lines.append(f"    {b_i} {b_type} {p_loads:.2f} {q_loads:.2f} 0 0 1 1.0 0 {float(row.vn_kv):.1f} 1 1.1 0.9 ;")
    m_lines.append("];\n")

    m_lines.append("%% generator data: bus Pg Qg Qmax Qmin Vg mBase status Pmax Pmin")
    m_lines.append("mpc.gen = [")
    for idx, row in net57.gen.iterrows():
        b_i = int(row.bus) + 1
        p_val = float(row.p_mw)
        m_lines.append(f"    {b_i} {p_val:.2f} 0 100 -50 1.0 100 1 {p_val*1.5:.2f} 0 ;")
    for idx, row in net57.ext_grid.iterrows():
        b_i = int(row.bus) + 1
        m_lines.append(f"    {b_i} 50.0 0 200 -100 1.0 100 1 200.0 0 ;")
    m_lines.append("];\n")

    m_lines.append("%% branch data: fbus tbus r x b rateA rateB rateC ratio angle status")
    m_lines.append("mpc.branch = [")
    for idx, row in net57.line.iterrows():
        fb = int(row.from_bus) + 1
        tb = int(row.to_bus) + 1
        r_val = float(row.r_ohm_per_km * row.length_km) / 100.0
        x_val = float(row.x_ohm_per_km * row.length_km) / 100.0
        rate = float(row.max_i_ka * 100.0) if "max_i_ka" in row else 50.0
        m_lines.append(f"    {fb} {tb} {r_val:.5f} {x_val:.5f} 0 {rate:.1f} 0 0 0 0 1 ;")
    m_lines.append("];\n")

    return "\n".join(m_lines)


def test_root_and_openapi():
    """Verify service root and metadata."""
    resp = requests.get(f"{BASE_URL}/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "online"
    assert "endpoints" in data


def test_matpower_case57_upload():
    """Test uploading MATPOWER .m case (IEEE 57-bus, not in training set)."""
    m_text = generate_matpower_case57_text()
    files = {
        "files": ("case57.m", io.BytesIO(m_text.encode("utf-8")), "text/plain")
    }
    resp = requests.post(f"{BASE_URL}/grids/upload?grid_name=IEEE%2057-Bus", files=files)
    assert resp.status_code == 200
    data = resp.json()

    assert data["valid"] is True
    assert data["num_buses"] == 57
    assert data["slack_present"] is True
    assert data["ac_converged"] is True
    assert "grid_id" in data
    # Confirm out-of-training range detection
    ood = data["ood_status"]
    assert ood["status"] in ("borderline", "outside")
    assert any("57 buses" in r for r in ood["reasons"])


def test_broken_file_upload():
    """Verify rejection of malformed MATPOWER text without crashing."""
    broken_text = "mpc.bus = [ invalid text without numbers ];"
    files = {
        "files": ("broken.m", io.BytesIO(broken_text.encode("utf-8")), "text/plain")
    }
    resp = requests.post(f"{BASE_URL}/grids/upload", files=files)
    assert resp.status_code == 400


def test_oversized_file_upload():
    """Verify security rejection of files exceeding 5MB."""
    large_bytes = b"0" * (6 * 1024 * 1024)  # 6 MB
    files = {
        "files": ("huge.m", io.BytesIO(large_bytes), "text/plain")
    }
    resp = requests.post(f"{BASE_URL}/grids/upload", files=files)
    assert resp.status_code == 400
    assert "5 MB" in resp.json()["detail"]


def test_oversized_bus_count_rejection():
    """Verify rejection of grids with > 500 buses."""
    # Create artificial 505-bus MATPOWER file
    bus_lines = ["    %d 1 0 0 0 0 1 1.0 0 135 1 1.1 0.9 ;" % (i + 1) for i in range(505)]
    bus_lines[0] = "    1 3 0 0 0 0 1 1.0 0 135 1 1.1 0.9 ;"  # slack
    m_text = "mpc.baseMVA = 100.0;\nmpc.bus = [\n" + "\n".join(bus_lines) + "\n];\nmpc.gen = [ 1 100 0 100 0 1.0 100 1 100 0 ; ];\nmpc.branch = [ 1 2 0.01 0.05 0 100 0 0 0 0 1 ; ];\n"
    files = {
        "files": ("oversized.m", io.BytesIO(m_text.encode("utf-8")), "text/plain")
    }
    resp = requests.post(f"{BASE_URL}/grids/upload", files=files)
    assert resp.status_code == 400
    assert "exceeds" in resp.json()["errors"][0]


def test_grid_endpoints():
    """Verify GET /grids, GET /grids/{id}, and GET /grids/{id}/stats."""
    # List grids
    resp = requests.get(f"{BASE_URL}/grids")
    assert resp.status_code == 200
    grids = resp.json()
    assert len(grids) >= 2
    case30_item = next(g for g in grids if g["id"] == "case30")
    assert case30_item["num_buses"] == 30
    assert case30_item["ood_status"]["status"] == "in_range"

    # Get single grid
    resp_30 = requests.get(f"{BASE_URL}/grids/case30")
    assert resp_30.status_code == 200

    # Get stats
    resp_stats = requests.get(f"{BASE_URL}/grids/case30/stats")
    assert resp_stats.status_code == 200
    stats = resp_stats.json()
    assert stats["counts"]["buses"] == 30
    assert stats["total_demand_mw"] > 0
    assert len(stats["loading_histogram"]) == 6
    assert "num_bridge_branches" in stats


def test_predict_upgraded_fields():
    """Verify /predict returns all Phase 1 upgraded fields."""
    payload = {
        "grid_id": "case30",
        "outaged": ["line_3"],
        "load_scale": 1.05
    }
    t0 = time.perf_counter()
    resp = requests.post(f"{BASE_URL}/predict", json=payload)
    latency_ms = (time.perf_counter() - t0) * 1000.0

    assert resp.status_code == 200
    data = resp.json()

    # Verify new fields
    assert "before_after" in data
    assert "max_loading_before" in data["before_after"]
    assert "max_loading_after" in data["before_after"]
    assert "mw_rerouted" in data["before_after"]
    assert "voltage_violations" in data["before_after"]
    assert "islanded_buses" in data["before_after"]

    assert "second_opinion" in data
    assert data["second_opinion"]["model"] == "XGBoost"
    assert "agrees" in data["second_opinion"]

    assert "confidence_margin" in data
    assert "feature_group_contribution" in data
    assert "loading" in data["feature_group_contribution"]
    assert "voltage" in data["feature_group_contribution"]
    assert "load_generation" in data["feature_group_contribution"]
    assert "topology" in data["feature_group_contribution"]

    assert "narrative" in data
    assert len(data["narrative"]) > 20

    assert "ood_status" in data
    assert data["ood_status"]["status"] == "in_range"

    print(f"\nMeasured /predict Latency: {latency_ms:.2f} ms")


def test_whatif_curve():
    """Verify /whatif-curve returns stepped risk predictions."""
    payload = {
        "grid_id": "case30",
        "outaged": ["line_3"],
        "min_load": 0.6,
        "max_load": 1.2,
        "step": 0.05
    }
    resp = requests.post(f"{BASE_URL}/whatif-curve", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["curve_points"]) >= 12
    assert data["curve_points"][0]["load_scale"] == 0.6


def test_criticality_map():
    """Verify /criticality-map screening and polling."""
    payload = {
        "grid_id": "case30",
        "load_scale": 1.0
    }
    t0 = time.perf_counter()
    resp = requests.post(f"{BASE_URL}/criticality-map", json=payload)
    latency_ms = (time.perf_counter() - t0) * 1000.0

    assert resp.status_code == 200
    data = resp.json()

    # For case30, returns completed directly or with task_id
    if data["status"] == "completed":
        assert len(data["result"]["top_10_critical_elements"]) == 10
    else:
        task_id = data["task_id"]
        # Poll
        for _ in range(10):
            time.sleep(0.5)
            poll_resp = requests.get(f"{BASE_URL}/criticality-map/{task_id}")
            poll_data = poll_resp.json()
            if poll_data["status"] == "completed":
                assert len(poll_data["result"]["top_10_critical_elements"]) == 10
                break

    print(f"Measured /criticality-map Response Latency: {latency_ms:.2f} ms")


def test_templates_and_calibration_stub():
    """Verify templates and 501 calibration stub."""
    # Templates
    resp_csv = requests.get(f"{BASE_URL}/templates/csv")
    assert resp_csv.status_code == 200
    assert "bus_csv" in resp_csv.json()

    resp_m = requests.get(f"{BASE_URL}/templates/matpower-example")
    assert resp_m.status_code == 200
    assert "mpc.bus" in resp_m.text

    # Calibration 501 stub
    resp_cal = requests.post(f"{BASE_URL}/grids/case30/calibrate")
    assert resp_cal.status_code == 501
    assert resp_cal.json()["message"] == "planned"
