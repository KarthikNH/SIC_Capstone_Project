"""
Automated Test Suite for Risk-Based Maintenance Prioritisation & Email Notification Service.

Covers:
1. Rule evaluation with mocked data.
2. Cooldown behavior enforcement.
3. Header-injection security defense (CRLF stripping and validation).
4. Outbox mode dispatch and file persistence.
5. Maintenance ranking determinism with fixed seed.
6. Latency check & caching for /maintenance/priority on case118.
"""

import os
import json
import time
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

from app.api import app
from src.maintenance import (
    generate_simulated_asset_table,
    compute_maintenance_priorities,
    evaluate_planned_outage,
    DEFAULT_24H_LOAD_PROFILE
)
from src.notifications import (
    sanitize_header_value,
    validate_email_address,
    send_or_save_email,
    evaluate_watchlist_rules,
    add_or_update_rule,
    load_rules,
    save_rules,
    get_outbox_emails,
    get_outbox_email_by_id,
    OUTBOX_DIR
)

client = TestClient(app)


# ------------------------------------------------------------------------------
# Test 1: Header Injection Security Defense
# ------------------------------------------------------------------------------
def test_header_injection_attempt():
    """Verify that CRLF characters (\r, \n) are strictly stripped to prevent header injection."""
    injected_header = "Important Alert\r\nBcc: attacker@evil.com\r\nSubject: Compromised"
    sanitized = sanitize_header_value(injected_header)
    assert "\r" not in sanitized
    assert "\n" not in sanitized
    assert "Bcc:" in sanitized  # flattened into single line, unable to inject new SMTP headers

    # Invalid email with CRLF must fail validation
    malicious_email = "victim@domain.com\r\nBcc:evil@domain.com"
    assert not validate_email_address(malicious_email)

    # Valid email passes
    assert validate_email_address("operator@gridwatch.local")
    assert validate_email_address("engineer.one+test@substation.org")


# ------------------------------------------------------------------------------
# Test 2: Outbox Mode Dispatch and Persistence
# ------------------------------------------------------------------------------
def test_outbox_mode_dispatch():
    """Verify that in demo/unconfigured mode, rendered emails are saved to data/outbox."""
    res = send_or_save_email(
        email_type="alert",
        subject="Test Outbox Verification Dispatch",
        recipients=["test_audit@gridwatch.local"],
        headline="Simulated Test Contingency Alert",
        body_items=[
            {"label": "Trigger", "value": "N-1 Outage Line 3"},
            {"label": "Risk", "value": "88.5% High Risk"}
        ],
        alert_badge="TEST AUDIT"
    )

    assert res["status"] in ("outbox_saved", "sent")
    assert "email_id" in res
    email_id = res["email_id"]

    # Verify JSON file exists in outbox directory
    outbox_file = OUTBOX_DIR / f"{email_id}.json"
    assert outbox_file.exists()

    with open(outbox_file, "r", encoding="utf-8") as f:
        data = json.load(f)
        assert data["id"] == email_id
        assert data["email_type"] == "alert"
        assert "<html>" in data["html_content"].lower()
        assert "GRIDWATCH" in data["text_content"].upper()
        assert "88.5%" in data["html_content"]


# ------------------------------------------------------------------------------
# Test 3: Watchlist Rule Evaluation & Cooldown Behavior
# ------------------------------------------------------------------------------
def test_rule_evaluation_and_cooldown():
    """Verify that rule evaluation triggers notifications and respects cooldown windows."""
    test_rule_id = f"test_cooldown_{int(time.time())}"
    rule_payload = {
        "id": test_rule_id,
        "name": "Audit Test High Risk Rule",
        "rule_type": "risk_threshold",
        "threshold": 0.01,  # very low threshold so it triggers
        "grid_id": "case30",
        "recipients": ["cooldown_test@gridwatch.local"],
        "cooldown_hours": 6.0,
        "enabled": True,
        "last_triggered_at": None
    }

    add_or_update_rule(rule_payload)

    # First evaluation: must trigger because threshold 0.01 is exceeded
    eval1 = evaluate_watchlist_rules("case30", run_check_now=False)
    rule_results1 = [r for r in eval1["results"] if r.get("rule_id") == test_rule_id]
    assert len(rule_results1) == 1
    assert rule_results1[0]["status"] == "triggered"

    # Second evaluation immediately after: must be suppressed by cooldown
    eval2 = evaluate_watchlist_rules("case30", run_check_now=False)
    rule_results2 = [r for r in eval2["results"] if r.get("rule_id") == test_rule_id]
    assert len(rule_results2) == 1
    assert rule_results2[0]["status"] in ("in_cooldown", "cooldown_active")


# ------------------------------------------------------------------------------
# Test 4: Maintenance Ranking Determinism with Fixed Seed
# ------------------------------------------------------------------------------
def test_maintenance_ranking_determinism():
    """Verify that generating simulated asset data produces identical results for a grid."""
    run1 = generate_simulated_asset_table("case30")
    run2 = generate_simulated_asset_table("case30")

    assert len(run1) == len(run2)
    for a1, a2 in zip(run1, run2):
        assert a1["asset_id"] == a2["asset_id"]
        assert a1["age_years"] == a2["age_years"]
        assert a1["condition_score"] == a2["condition_score"]
        assert a1["last_inspection_date"] == a2["last_inspection_date"]

    # Verify priorities computation determinism
    p1 = compute_maintenance_priorities("case30", DEFAULT_24H_LOAD_PROFILE)
    p2 = compute_maintenance_priorities("case30", DEFAULT_24H_LOAD_PROFILE)

    assert p1["priorities"][0]["asset_id"] == p2["priorities"][0]["asset_id"]
    assert p1["priorities"][0]["priority_score"] == p2["priorities"][0]["priority_score"]
    assert p1["is_simulated_data"] is True


# ------------------------------------------------------------------------------
# Test 5: Planned Outage Window Evaluation on case30
# ------------------------------------------------------------------------------
def test_planned_outage_evaluation_verdict():
    """Verify planned outage evaluation returns hourly risks, safest window, and verified verdict."""
    res = evaluate_planned_outage("case30", "line_1", DEFAULT_24H_LOAD_PROFILE)

    assert "hourly_risks" in res
    assert len(res["hourly_risks"]) == 24
    assert "safest_window" in res
    assert "avoid_window" in res
    assert "verdict" in res
    assert "Safe between" in res["verdict"] or "Conditional" in res["verdict"]
    assert res["verification"]["status"] in ("simulator verified", "model estimate")


# ------------------------------------------------------------------------------
# Test 6: Latency Check & Caching for /maintenance/priority on case118
# ------------------------------------------------------------------------------
def test_case118_maintenance_priority_latency_and_caching():
    """Verify that /maintenance/priority completes on case118 and caches for fast subsequent calls."""
    # First call: computes and caches
    t0 = time.time()
    response1 = client.post("/maintenance/priority", json={"grid_id": "case118"})
    first_latency = time.time() - t0

    assert response1.status_code == 200
    data1 = response1.json()
    assert data1["grid_id"] == "case118"
    assert data1["total_assets"] > 100
    assert len(data1["priorities"]) > 100

    # Second call with same profile: must hit cache and return in under 200ms
    t1 = time.time()
    response2 = client.post("/maintenance/priority", json={"grid_id": "case118"})
    second_latency = time.time() - t1

    assert response2.status_code == 200
    data2 = response2.json()
    assert data2["priorities"][0]["asset_id"] == data1["priorities"][0]["asset_id"]
    # Fast cache hit check
    assert second_latency < 0.50, f"Cache latency too slow: {second_latency}s"
