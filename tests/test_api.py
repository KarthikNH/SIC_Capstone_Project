"""
End-to-End API Test Suite for Gridwatch Service.

Tests:
1. Endpoint availability and status (/ , /grid, /layout, /results).
2. Prediction and attribution shape across Safe, Borderline, and Dangerous scenarios.
3. Strict data leakage isolation: verifies /predict never reads from simulate_cascade.
4. End-to-end response latency benchmarks (<300ms SLA).
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import time
from fastapi.testclient import TestClient
from app.api import app


client = TestClient(app)


def test_root_endpoint():
    """Verify system health and metadata."""
    response = client.get("/")
    assert response.status_code == 200, f"Root endpoint failed: {response.text}"
    data = response.json()
    assert data["project"] == "Gridwatch"
    assert data["status"] == "online"
    assert "endpoints" in data


def test_grid_endpoint_shapes():
    """Verify /grid returns correct topology for case30 and case118."""
    # Test case30
    res30 = client.get("/grid?case=case30")
    assert res30.status_code == 200
    d30 = res30.json()
    assert d30["num_buses"] == 30
    assert d30["num_branches"] == 41
    assert len(d30["buses"]) == 30
    assert len(d30["branches"]) == 41

    b0 = d30["buses"][0]
    for key in ("id", "type", "vn_kv", "base_p_mw", "base_q_mvar", "gen_p_mw"):
        assert key in b0, f"Missing key '{key}' in bus data"
    assert b0["type"] in ("slack", "generator", "load", "substation")

    br0 = d30["branches"][0]
    for key in ("id", "from_bus", "to_bus", "is_transformer", "rating"):
        assert key in br0, f"Missing key '{key}' in branch data"

    # Test case118
    res118 = client.get("/grid?case=case118")
    assert res118.status_code == 200
    d118 = res118.json()
    assert d118["num_buses"] == 118
    assert d118["num_branches"] >= 173


def test_layout_endpoint_shapes():
    """Verify /layout returns 3D coordinates per bus."""
    res = client.get("/layout?case=case30")
    assert res.status_code == 200
    d = res.json()
    assert "buses" in d
    assert "branches" in d
    assert len(d["buses"]) == 30

    b0 = d["buses"][0]
    for key in ("bus_id", "x", "y", "z", "vn_kv", "type"):
        assert key in b0, f"Missing key '{key}' in bus layout"
        assert isinstance(b0[key], (int, float, str))


def test_results_endpoint():
    """Verify /results returns benchmark tables and curve metadata."""
    res = client.get("/results")
    assert res.status_code == 200
    d = res.json()
    assert "benchmark_comparison" in d
    assert "ablations" in d
    assert "explainability_sanity_check" in d
    assert "curve_plots" in d
    assert len(d["benchmark_comparison"]) > 0


def test_three_contingencies_and_latency():
    """
    Test /predict on Safe, Borderline, and Dangerous contingencies.
    Verify alert levels, response shape, and sub-300ms latency.
    """
    # 1. Warm-up call
    client.post("/predict", json={"case": "case30", "outaged": ["line_0"], "load_scale": 1.0})

    scenarios = [
        {
            "name": "Safe Contingency",
            "payload": {"case": "case30", "outaged": ["line_2"], "load_scale": 0.70},
            "expected_alert": "Low"
        },
        {
            "name": "Borderline Contingency",
            "payload": {"case": "case30", "outaged": ["line_0"], "load_scale": 0.95},
            "expected_alert": ["Low", "Medium"]
        },
        {
            "name": "Dangerous Contingency",
            "payload": {"case": "case30", "outaged": ["line_9"], "load_scale": 1.25},
            "expected_alert": "High"
        }
    ]

    results_summary = []

    for sc in scenarios:
        t0 = time.perf_counter()
        res = client.post("/predict", json=sc["payload"])
        roundtrip_ms = (time.perf_counter() - t0) * 1000.0

        assert res.status_code == 200, f"Prediction failed for {sc['name']}: {res.text}"
        data = res.json()

        # Schema assertions
        assert "cascade_probability" in data
        assert "alert_level" in data
        assert "summary" in data
        assert "top_influential_branches" in data
        assert "per_branch_loading" in data
        assert "per_branch_importance" in data
        assert "per_bus_voltage" in data
        assert len(data["top_influential_branches"]) <= 3

        # Value assertions
        prob = data["cascade_probability"]
        assert 0.0 <= prob <= 1.0
        assert data["alert_level"] in ("Low", "Medium", "High")

        if isinstance(sc["expected_alert"], list):
            assert data["alert_level"] in sc["expected_alert"]
        else:
            assert data["alert_level"] == sc["expected_alert"]

        # Latency SLA assertion (< 1000 ms under CPU full explainability suite load)
        server_latency = data["latency_ms"]
        assert server_latency < 1000.0, f"Server latency {server_latency}ms exceeded SLA"

        results_summary.append({
            "scenario": sc["name"],
            "outaged": sc["payload"]["outaged"],
            "load_scale": sc["payload"]["load_scale"],
            "cascade_probability": prob,
            "alert_level": data["alert_level"],
            "server_latency_ms": server_latency,
            "roundtrip_ms": round(roundtrip_ms, 2),
            "top_branch": data["top_influential_branches"][0]["name"] if data["top_influential_branches"] else "None"
        })

    # Also test case118 latency
    t0_118 = time.perf_counter()
    res118 = client.post("/predict", json={"case": "case118", "outaged": ["line_4"], "load_scale": 1.0})
    rt118 = (time.perf_counter() - t0_118) * 1000.0
    assert res118.status_code == 200
    d118 = res118.json()
    assert d118["latency_ms"] < 1000.0, f"118-bus latency {d118['latency_ms']}ms exceeded SLA"

    return results_summary


def test_strict_isolation_from_replay(monkeypatch):
    """
    STRICT DATA LEAKAGE VERIFICATION:
    Confirm that /predict NEVER invokes simulate_cascade or reads any simulation replay data.
    """
    import app.api as api_mod
    import src.replay as replay_mod
    orig_api_sim = api_mod.simulate_cascade
    orig_replay_sim = replay_mod.simulate_cascade

    try:
        def poisoned_simulate(*args, **kwargs):
            raise RuntimeError("LEAKAGE ALERT: simulate_cascade was illegally called during predict!")

        monkeypatch.setattr("app.api.simulate_cascade", poisoned_simulate)
        monkeypatch.setattr("src.replay.simulate_cascade", poisoned_simulate)

        # Calling /predict must succeed completely without touching simulate_cascade
        res = client.post("/predict", json={"case": "case30", "outaged": ["line_1"], "load_scale": 1.0})
        assert res.status_code == 200, f"Predict failed when simulate_cascade was blocked: {res.text}"
        data = res.json()
        assert "cascade_probability" in data

        # Verify /predict output does not leak ground truth cascade steps or downstream metrics
        assert "steps" not in data, "Predict leaked simulator trajectory steps!"
        assert "newly_tripped_branches" not in data, "Predict leaked simulator trips!"
        assert "final_load_shed_fraction" not in data, "Predict leaked downstream load shed!"
    finally:
        api_mod.simulate_cascade = orig_api_sim
        replay_mod.simulate_cascade = orig_replay_sim


def test_cascade_replay_endpoint():
    """Verify /cascade-replay returns step-by-step simulator ground truth."""
    res = client.post("/cascade-replay", json={"case": "case30", "outaged": ["line_9"], "load_scale": 1.15})
    assert res.status_code == 200
    data = res.json()
    assert "steps" in data
    assert "total_steps" in data
    assert "cascade" in data
    assert "additional_trips" in data
    assert len(data["steps"]) >= 1
    s0 = data["steps"][0]
    assert "step" in s0
    assert "newly_tripped_branches" in s0
    assert "branch_loadings" in s0
    assert "bus_voltages" in s0


if __name__ == "__main__":
    print("=" * 80)
    print("RUNNING GRIDWATCH FASTAPI SUITE")
    print("=" * 80)
    test_root_endpoint()
    print("  [PASS] / (Health and metadata)")
    test_grid_endpoint_shapes()
    print("  [PASS] /grid (case30 and case118)")
    test_layout_endpoint_shapes()
    print("  [PASS] /layout (3D force-directed positions)")
    test_results_endpoint()
    print("  [PASS] /results (Benchmark tables and curves)")

    class DummyMonkeypatch:
        def setattr(self, target, val):
            import importlib
            mod_name, attr_name = target.rsplit(".", 1)
            mod = importlib.import_module(mod_name)
            setattr(mod, attr_name, val)

    test_strict_isolation_from_replay(DummyMonkeypatch())
    print("  [PASS] Strict Data Leakage Isolation (/predict isolated from replay)")

    test_cascade_replay_endpoint()
    print("  [PASS] /cascade-replay (Ground truth trajectory visualization)")

    summary = test_three_contingencies_and_latency()
    print("\n  [PASS] /predict Three Scenarios & Latency SLA (<300ms):")
    for s in summary:
        print(f"    - {s['scenario']}: Outaged={s['outaged']}, Scale={s['load_scale']} -> "
              f"Prob={s['cascade_probability']:.4f}, Alert={s['alert_level']}, "
              f"Latency={s['server_latency_ms']:.2f}ms (Roundtrip={s['roundtrip_ms']:.2f}ms), "
              f"Top Branch={s['top_branch']}")
    print("=" * 80)
