"""
Criticality Screening & Risk Map Engine.

Runs N-1 contingency screening across all branches and generators to determine
the single most critical elements in the power grid.
Supports background task execution, live progress polling, and persistent caching.
"""

import copy
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import uuid

import numpy as np
import pandapower as pp

from src.grid_manager import load_grid_by_id
from src.inference import predict


# Global caches and task store
_CRITICALITY_CACHE: Dict[Tuple[str, float], Dict[str, Any]] = {}
_CRITICALITY_TASKS: Dict[str, Dict[str, Any]] = {}
_TASK_LOCK = threading.Lock()


def run_criticality_worker(
    task_id: str,
    grid_id: str,
    load_scale: float
) -> None:
    """Worker running in a background thread."""
    t_start = time.perf_counter()
    cache_key = (grid_id, round(float(load_scale), 2))

    try:
        net = load_grid_by_id(grid_id)
    except Exception as e:
        with _TASK_LOCK:
            _CRITICALITY_TASKS[task_id]["status"] = "failed"
            _CRITICALITY_TASKS[task_id]["error"] = str(e)
        return

    elements: List[Dict[str, str]] = []
    # Lines
    for l_idx in net.line.index:
        fb, tb = int(net.line.loc[l_idx, "from_bus"]), int(net.line.loc[l_idx, "to_bus"])
        elements.append({
            "id": f"line_{l_idx}",
            "type": "branch",
            "name": f"Line {fb}-{tb}"
        })

    # Generators
    for g_idx in net.gen.index:
        gb = int(net.gen.loc[g_idx, "bus"])
        elements.append({
            "id": f"gen_{g_idx}",
            "type": "generator",
            "name": f"Gen at Bus {gb}"
        })

    total_elements = len(elements)
    with _TASK_LOCK:
        _CRITICALITY_TASKS[task_id]["total"] = total_elements

    results: List[Dict[str, Any]] = []

    for idx, elem in enumerate(elements):
        try:
            res = predict(
                grid_case=grid_id,
                outaged_elements=[elem["id"]],
                load_scale=load_scale
            )
            prob = res["cascade_probability"]
            alert = res["alert_level"]
            max_load = res["before_after"]["max_loading_after"]
        except Exception:
            prob = 0.0
            alert = "Low"
            max_load = 0.0

        results.append({
            "element_id": elem["id"],
            "element_name": elem["name"],
            "type": elem["type"],
            "cascade_probability": prob,
            "alert_level": alert,
            "max_loading_percent": max_load
        })

        with _TASK_LOCK:
            _CRITICALITY_TASKS[task_id]["completed"] = idx + 1
            _CRITICALITY_TASKS[task_id]["progress"] = round((idx + 1) / total_elements, 3)

    # Sort descending by cascade risk probability
    results.sort(key=lambda r: r["cascade_probability"], reverse=True)
    top_10 = results[:10]
    elapsed_ms = round((time.perf_counter() - t_start) * 1000.0, 2)

    final_payload = {
        "grid_id": grid_id,
        "load_scale": load_scale,
        "total_elements_screened": total_elements,
        "elapsed_ms": elapsed_ms,
        "top_10_critical_elements": top_10,
        "all_elements_screened": results
    }

    # Save to memory cache and task record
    _CRITICALITY_CACHE[cache_key] = copy.deepcopy(final_payload)

    with _TASK_LOCK:
        _CRITICALITY_TASKS[task_id]["status"] = "completed"
        _CRITICALITY_TASKS[task_id]["progress"] = 1.0
        _CRITICALITY_TASKS[task_id]["result"] = final_payload


def start_criticality_analysis(
    grid_id: str,
    load_scale: float = 1.0
) -> Dict[str, Any]:
    """
    Start or retrieve criticality screening.
    Returns immediately with cached result if available, or spawns background thread.
    """
    cache_key = (grid_id, round(float(load_scale), 2))

    if cache_key in _CRITICALITY_CACHE:
        cached = copy.deepcopy(_CRITICALITY_CACHE[cache_key])
        return {
            "task_id": "cached",
            "status": "completed",
            "progress": 1.0,
            "cached": True,
            "result": cached
        }

    task_id = f"crit_{grid_id}_{uuid.uuid4().hex[:8]}"

    with _TASK_LOCK:
        _CRITICALITY_TASKS[task_id] = {
            "task_id": task_id,
            "grid_id": grid_id,
            "load_scale": load_scale,
            "status": "running",
            "progress": 0.0,
            "completed": 0,
            "total": 0,
            "created_at": time.time(),
            "result": None
        }

    # Launch in daemon thread
    thread = threading.Thread(
        target=run_criticality_worker,
        args=(task_id, grid_id, load_scale),
        daemon=True
    )
    thread.start()

    # If small grid (e.g. case30), wait up to 1.5s for fast synchronous return
    if grid_id == "case30":
        thread.join(timeout=1.5)
        with _TASK_LOCK:
            task_info = copy.deepcopy(_CRITICALITY_TASKS[task_id])
        if task_info["status"] == "completed":
            return {
                "task_id": task_id,
                "status": "completed",
                "progress": 1.0,
                "cached": False,
                "result": task_info["result"]
            }

    return {
        "task_id": task_id,
        "status": "running",
        "progress": 0.0,
        "cached": False,
        "message": "Criticality screening running in background. Poll /criticality-map/{task_id}."
    }


def get_criticality_status(task_id: str) -> Dict[str, Any]:
    """Poll progress and retrieve result for a criticality screening task."""
    with _TASK_LOCK:
        if task_id not in _CRITICALITY_TASKS:
            raise KeyError(f"Task ID '{task_id}' not found.")
        return copy.deepcopy(_CRITICALITY_TASKS[task_id])
