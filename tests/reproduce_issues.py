import json
import math
import urllib.request
import traceback

def check_value(val, path=""):
    if val is None:
        return [f"NULL at {path}"]
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return [f"NAN/INF at {path}: {val}"]
    errors = []
    if isinstance(val, dict):
        for k, v in val.items():
            errors.extend(check_value(v, f"{path}.{k}" if path else k))
    elif isinstance(val, list):
        for idx, item in enumerate(val):
            errors.extend(check_value(item, f"{path}[{idx}]"))
    return errors

import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from fastapi.testclient import TestClient
from app.api import app

client = TestClient(app)

def test_endpoint(endpoint_path, payload):
    try:
        resp = client.post(endpoint_path, json=payload)
        if resp.status_code == 200:
            data = resp.json()
            errs = check_value(data)
            return True, data, errs
        else:
            return False, f"HTTP {resp.status_code}: {resp.text}", [f"HTTP Error {resp.status_code}"]
    except Exception as e:
        return False, str(e), [f"Exception: {str(e)}"]

def run_tests():
    test_cases = {
        "case30": [
            (["line_0"], 1.0),
            (["line_1"], 1.0),
            (["line_3"], 1.05),
            (["line_5"], 1.15),
            (["line_8"], 1.0),
            (["line_0", "line_1"], 1.0),
            (["line_3", "line_5"], 1.1),
            (["line_8", "line_10"], 1.05),
            (["line_2", "line_4"], 1.0),
            (["line_6", "line_7"], 1.15),
        ],
        "case118": [
            (["line_0"], 1.0),
            (["line_5"], 1.0),
            (["line_10"], 1.05),
            (["line_20"], 1.1),
            (["line_30"], 1.0),
            (["line_0", "line_5"], 1.0),
            (["line_10", "line_12"], 1.05),
            (["line_25", "line_26"], 1.1),
            (["line_40", "line_41"], 1.0),
            (["line_50", "line_55"], 1.15),
        ],
        "custom_a7409e482b": [
            (["line_0"], 1.0),
            (["line_1"], 1.0),
            (["line_5"], 1.05),
            (["line_10"], 1.1),
            (["line_15"], 1.0),
            (["line_0", "line_1"], 1.0),
            (["line_2", "line_3"], 1.05),
            (["line_5", "line_6"], 1.1),
            (["line_10", "line_12"], 1.0),
            (["line_15", "line_16"], 1.15),
        ]
    }

    results = []

    for grid_id, outages in test_cases.items():
        print(f"\n==========================================")
        print(f"Testing Grid: {grid_id}")
        print(f"==========================================")
        for outaged, load_scale in outages:
            payload = {
                "grid_id": grid_id,
                "outaged": outaged,
                "load_scale": load_scale
            }
            
            # 1. /predict
            ok_pred, data_pred, errs_pred = test_endpoint("/predict", payload)
            # 2. /cascade-replay
            ok_rep, data_rep, errs_rep = test_endpoint("/cascade-replay", payload)
            
            pred_prob = data_pred.get("cascade_probability") if ok_pred else "ERR"
            rep_cascade = data_rep.get("cascade") if ok_rep else "ERR"
            rep_steps = len(data_rep.get("steps", [])) if ok_rep else 0
            
            status_line = (
                f"[{grid_id}] Outaged={outaged} Load={load_scale} | "
                f"Predict: {'OK' if ok_pred else 'FAIL'} (prob={pred_prob}) | "
                f"Replay: {'OK' if ok_rep else 'FAIL'} (cascade={rep_cascade}, steps={rep_steps})"
            )
            print(status_line)
            
            if errs_pred:
                print(f"   PREDICT ERRORS: {errs_pred}")
            if errs_rep:
                print(f"   REPLAY ERRORS: {errs_rep}")

            # Also check missing fields specified in requirement:
            missing_pred_fields = []
            if ok_pred:
                for f in ["probability", "alert_threshold", "alert_level", "predicted_cascade"]:
                    if f not in data_pred:
                        missing_pred_fields.append(f)
            
            missing_rep_fields = []
            if ok_rep:
                for f in ["actual_cascade", "cascade_criterion", "k_extra_trips", "load_shed_threshold"]:
                    if f not in data_rep:
                        missing_rep_fields.append(f)
                        
            if missing_pred_fields:
                print(f"   PREDICT MISSING REQUIRED SPEC FIELDS: {missing_pred_fields}")
            if missing_rep_fields:
                print(f"   REPLAY MISSING REQUIRED SPEC FIELDS: {missing_rep_fields}")
                
            results.append({
                "grid_id": grid_id,
                "outaged": outaged,
                "load_scale": load_scale,
                "ok_pred": ok_pred,
                "errs_pred": errs_pred,
                "missing_pred_fields": missing_pred_fields,
                "ok_rep": ok_rep,
                "errs_rep": errs_rep,
                "missing_rep_fields": missing_rep_fields,
                "pred_prob": pred_prob,
                "rep_cascade": rep_cascade,
                "rep_steps": rep_steps,
            })

    print("\nSummary of failures:")
    fails = [r for r in results if not r["ok_pred"] or not r["ok_rep"] or r["errs_pred"] or r["errs_rep"]]
    print(f"Total tests: {len(results)}, Failures: {len(fails)}")

if __name__ == "__main__":
    run_tests()
