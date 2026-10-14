"""
Gridwatch / Grid Site: FastAPI Backend Service.

High-performance API supporting live, interactive early warning frontend for
power grid cascading failure prevention using Graph Isomorphism Networks (GINE).

Features:
- Sub-100ms live inference on N-1/N-2 contingencies and variable load scaling.
- Comprehensive grid upload & management: MATPOWER .m, pandapower JSON, and CSVs.
- Strict security & zero execution guarantee: no eval, no exec, no unpickling.
- Automated validation reports with plain-language diagnostics and derived rating assumptions.
- Out-of-training-range (OOD) detection based on grid size, feature quantiles, and embedding distance.
- Advanced metrics: before/after overload shifts, feature-group attribution, XGBoost second opinion,
  and deterministic template-based operator narrative.
- What-if risk curves and automated criticality screening map with background polling.
- 3D force-directed grid layout with voltage level vertical stratification.
- Isolated step-by-step cascade replay for ground-truth visualization.
- CORS-enabled for web frontends.
- Strict Zero-Leakage Guarantee: /predict strictly operates on t=0+ state.
"""

from contextlib import asynccontextmanager
import io
import json
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Union
import uuid
import zipfile
import hashlib

import numpy as np
import pandas as pd
import pandapower as pp
import pandapower.networks as pn
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.criticality import get_criticality_status, start_criticality_analysis
from src.dataset_card import (
    compare_grid_with_training_distribution,
    generate_dataset_card,
    get_dataset_card_cached,
    get_feature_distribution,
    get_scenario_sample,
    FEATURE_DICTIONARY,
    TABULAR_PATH,
    RAW_DATA_PATH
)
from src.explainability_extensions import get_global_insights, compute_suggested_fix
from src.mitigation import evaluate_mitigation_actions
from src.chat_service import stream_chat_response
from src.topology import compute_grid_topology
from src.grid_manager import (
    UPLOADS_DIR,
    compute_grid_statistics,
    delete_uploaded_grid,
    get_grid_3d_layout,
    get_grid_metadata,
    list_available_grids,
    load_grid_by_id,
    matpower_data_to_pandapower,
    parse_csv_grid_data,
    parse_matpower_text,
    register_uploaded_grid,
    validate_and_calibrate_grid,
)
from src.inference import compute_whatif_curve, load_inference_resources, predict
from src.layout import compute_or_load_3d_layout, compute_or_load_2d_layout
from src.ood_detector import evaluate_ood, get_grid_ood_status, get_training_ood_stats
from src.replay import simulate_cascade
from src.utils.config import load_config
from src.maintenance import (
    DEFAULT_24H_LOAD_PROFILE,
    get_grid_assets,
    generate_simulated_asset_table,
    get_asset_template_csv,
    save_uploaded_asset_data,
    compute_maintenance_priorities,
    evaluate_planned_outage,
)
from src.notifications import (
    get_notification_settings,
    update_notification_settings,
    list_rules,
    create_rule,
    delete_rule,
    evaluate_rules,
    send_test_email,
    send_digest_email,
    list_outbox_emails,
    get_outbox_email,
    get_notification_history,
)
import asyncio


PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
RESULTS_DIR = PROJECT_ROOT / "results"
MAX_UPLOAD_SIZE = 5 * 1024 * 1024  # 5 MB


# ==============================================================================
# Pydantic Schemas for Swagger / OpenAPI Documentation
# ==============================================================================

class PredictRequest(BaseModel):
    grid_id: Optional[str] = Field(
        default=None,
        description="Power grid identifier: 'case30', 'case118', or uploaded grid ID."
    )
    case: Optional[str] = Field(
        default=None,
        description="Alias for grid_id (backwards compatibility with existing frontends)."
    )
    outaged: List[Union[str, int]] = Field(
        default=["line_3"],
        description="List of 1 or 2 outaged elements to simulate N-1 or N-2 contingencies (e.g. ['line_3'], ['line_3', 'line_17'], ['gen_1'])."
    )
    load_scale: float = Field(
        default=1.0,
        ge=0.5,
        le=1.5,
        description="System load scale multiplier (0.6 to 1.2 typical range)."
    )
    modifications: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Optional operational modifications (load_scale, line ratings, etc.)."
    )

    class Config:
        json_schema_extra = {
            "example": {
                "grid_id": "case30",
                "outaged": ["line_3"],
                "load_scale": 1.05
            }
        }


class WhatIfRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30")
    case: Optional[str] = Field(default=None)
    outaged: List[Union[str, int]] = Field(default=["line_3"])
    min_load: float = Field(default=0.6, ge=0.5, le=1.5)
    max_load: float = Field(default=1.2, ge=0.5, le=1.5)
    step: float = Field(default=0.05, ge=0.01, le=0.2)


class CriticalityRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30")
    case: Optional[str] = Field(default=None)
    load_scale: float = Field(default=1.0, ge=0.5, le=1.5)


class CascadeReplayRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30")
    case: Optional[str] = Field(default="case30")
    outaged: List[Union[str, int]] = Field(default=["line_3"])
    load_scale: float = Field(default=1.0, ge=0.5, le=1.5)
    modifications: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Optional operational modifications (load_scale, line ratings, etc.)."
    )


class SuggestFixRequest(BaseModel):
    grid_id: Optional[str] = Field(default=None)
    case: Optional[str] = Field(default=None)
    outaged: List[Union[str, int]] = Field(default=["line_3"])
    load_scale: float = Field(default=1.0, ge=0.5, le=1.5)
    current_probability: Optional[float] = Field(default=None)
    actual_cascade: Optional[bool] = Field(default=None)
    modifications: Optional[Dict[str, Any]] = Field(default=None)


class MitigateRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30", description="Power grid identifier")
    case: Optional[str] = Field(default=None, description="Alias for grid_id")
    outaged: List[Union[str, int]] = Field(default=["line_3"], description="List of outaged elements")
    load_scale: float = Field(default=1.0, ge=0.5, le=1.5, description="Operating load scaling multiplier")
    verify: bool = Field(default=False, description="Whether to verify top candidate actions via cascade simulator")


class ChatMessage(BaseModel):
    role: str = Field(..., description="Message author role: 'user', 'assistant', or 'system'")
    content: str = Field(..., description="Message text content")


class ChatContext(BaseModel):
    grid_id: Optional[str] = Field(default="case30")
    case: Optional[str] = Field(default=None)
    outaged: Optional[List[Union[str, int]]] = Field(default=["line_3"])
    load_scale: Optional[float] = Field(default=1.0)


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(..., description="List of conversation turns")
    context: Optional[ChatContext] = Field(default_factory=ChatContext, description="Active grid context")


class MaintenancePriorityRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30", description="Power grid identifier (case30, case118, uploaded)")
    case: Optional[str] = Field(default=None, description="Alias for grid_id")
    load_profile: Optional[List[float]] = Field(default=None, description="24-hour load multiplier array (e.g. 0.60 to 1.20)")


class PlannedOutageRequest(BaseModel):
    grid_id: Optional[str] = Field(default="case30", description="Power grid identifier")
    case: Optional[str] = Field(default=None, description="Alias for grid_id")
    asset_id: str = Field(..., description="Target asset identifier e.g. 'line_0' or 'branch_0'")
    load_profile: Optional[List[float]] = Field(default=None, description="24-hour load multiplier array")


class NotificationSettingsRequest(BaseModel):
    confirmed_recipients: Optional[List[str]] = Field(default=None, description="List of confirmed recipient emails")
    digest_frequency: Optional[str] = Field(default=None, description="'daily' or 'weekly'")
    digest_recipients: Optional[List[str]] = Field(default=None, description="Recipients for scheduled digest")


class NotificationRuleRequest(BaseModel):
    name: str = Field(..., description="Human-readable rule name")
    rule_type: str = Field(..., description="'risk_threshold', 'system_load', 'saved_scenario', or 'maintenance_top3'")
    recipients: List[str] = Field(..., description="List of recipient email addresses")
    grid_id: Optional[str] = Field(default="case30", description="Associated grid ID")
    threshold: Optional[float] = Field(default=0.5, description="Trigger risk threshold (0.0 to 1.0)")
    load_scale: Optional[float] = Field(default=1.0, description="Trigger system load multiplier")
    scenario_outages: Optional[List[str]] = Field(default=None, description="Specific outaged elements for saved scenario rule")
    cooldown_hours: Optional[float] = Field(default=6.0, description="Minimum hours between alerts for this rule")
    enabled: Optional[bool] = Field(default=True, description="Whether rule is active")


class TestEmailRequest(BaseModel):
    recipient: str = Field(..., description="Target email address for test message")


class DigestEmailRequest(BaseModel):
    recipients: Optional[List[str]] = Field(default=None, description="Optional target recipients; defaults to configured digest recipients")
    grid_id: Optional[str] = Field(default="case30", description="Grid ID to summarize")


# ==============================================================================
# Lifespan Context Manager for Model Pre-Warming & Background Services
# ==============================================================================

async def _notification_scheduler_loop():
    """Background worker to periodically evaluate notification rules."""
    while True:
        try:
            await asyncio.sleep(60)  # Check rules once every minute
            evaluate_rules()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[SchedulerWorker] Rule evaluation error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Pre-warm GINE model, scalers, OOD stats, and layout files
    load_inference_resources("config.yaml")
    get_training_ood_stats()
    compute_or_load_3d_layout("case30")
    compute_or_load_3d_layout("case118")
    # Warm-up inference to eliminate initial JIT delay
    predict("case30", ["line_0"], 1.0)

    # Check that data/dataset_card.json exists; if missing, generate it automatically
    dataset_card_path = PROJECT_ROOT / "data" / "dataset_card.json"
    if not dataset_card_path.exists():
        print(f"[DatasetCard] Notice: {dataset_card_path} is missing. Automatically generating on startup...")
        try:
            generate_dataset_card()
            print(f"[DatasetCard] Successfully generated dataset card at {dataset_card_path}")
        except Exception as e:
            print(f"[DatasetCard] Warning: Could not generate dataset card automatically: {e}")
    else:
        print(f"[DatasetCard] Found valid dataset card at {dataset_card_path}")

    # Start background notification scheduler
    scheduler_task = asyncio.create_task(_notification_scheduler_loop())

    try:
        yield
    finally:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Gridwatch - Power Grid Cascading Failure Early Warning API",
    description=(
        "Production-grade early warning service for power transmission systems.\n\n"
        "Leverages a Graph Isomorphism Network with Edge features (GINE) to predict whether "
        "an initial N-1 or N-2 disturbance will trigger a widespread cascading blackout.\n\n"
        "**Strict Zero-Leakage Guarantee:** The model relies exclusively on the immediate "
        "$t=0^+$ post-disturbance AC power flow state before any cascade propagation occurs."
    ),
    version="1.1.0",
    lifespan=lifespan
)

# Enable CORS for interactive frontends on any localhost port
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static directory for logo, icons, and artifacts
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ==============================================================================
# System & Health
# ==============================================================================

@app.get("/", tags=["System"])
async def root():
    """System health check and project metadata."""
    return {
        "project": "Gridwatch",
        "title": "Grid Site - Cascading Failure Early Warning System",
        "status": "online",
        "version": "1.1.0",
        "docs_url": "/docs",
        "endpoints": {
            "grids": "GET /grids",
            "grid_upload": "POST /grids/upload",
            "grid_stats": "GET /grids/{id}/stats",
            "predict": "POST /predict",
            "whatif_curve": "POST /whatif-curve",
            "criticality_map": "POST /criticality-map",
            "cascade_replay": "POST /cascade-replay",
            "results": "GET /results"
        },
        "logo_url": "/static/logo.gif" if (STATIC_DIR / "logo.gif").exists() else None
    }


# ==============================================================================
# Grid Management & Upload
# ==============================================================================

@app.post("/grids/upload", tags=["Grid Management"])
async def upload_grid(
    files: List[UploadFile] = File(...),
    grid_name: Optional[str] = Query(None, description="Optional custom name for uploaded grid")
):
    """
    Upload and register custom power grid topology.
    Accepts:
    - MATPOWER `.m` text file.
    - Pandapower `.json` network file.
    - CSV files (`bus.csv`, `branch.csv`, optional `gen.csv`) as individual files or within a `.zip` archive.

    Security & Validation:
    - Never executes code (no eval, no exec).
    - Never unpickles data (pure text/JSON parsing).
    - File size limit: 5 MB.
    - Maximum bus count: 500 buses.
    - Automated validation report with AC power flow convergence, slack checks, and assumption flags.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided for upload.")

    # Check total size
    total_size = sum(f.size or 0 for f in files)
    if total_size > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail=f"Upload exceeds 5 MB limit (received {total_size} bytes).")

    allowed_exts = {".m", ".json", ".csv", ".zip"}
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in allowed_exts:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file extension '{ext}' for file '{f.filename}'. Allowed: .m, .json, .csv, .zip."
            )

    # Read file contents and compute content hash for de-duplication
    file_bytes_map: Dict[str, bytes] = {}
    hasher = hashlib.sha256()
    for f in files:
        b = await f.read()
        if len(b) > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=400, detail="File size exceeds 5 MB limit.")
        file_bytes_map[f.filename or "file"] = b
        hasher.update(b)

    content_hash = hasher.hexdigest()[:10]
    grid_id = f"custom_{content_hash}"

    # De-duplicate: if this identical file content was already uploaded, return existing metadata
    existing_meta = UPLOADS_DIR / grid_id / "metadata.json"
    if existing_meta.exists():
        report = get_grid_metadata(grid_id)
        report["ood_status"] = get_grid_ood_status(grid_id)
        return report

    net = None

    try:
        # Case 1: Single MATPOWER .m file
        if len(files) == 1 and files[0].filename.lower().endswith(".m"):
            content_bytes = file_bytes_map[files[0].filename]
            text = content_bytes.decode("utf-8", errors="replace")
            parsed_mpc = parse_matpower_text(text)
            net = matpower_data_to_pandapower(parsed_mpc)
            if not grid_name:
                grid_name = Path(files[0].filename).stem

        # Case 2: Single Pandapower .json file
        elif len(files) == 1 and files[0].filename.lower().endswith(".json"):
            content_bytes = file_bytes_map[files[0].filename]
            text = content_bytes.decode("utf-8", errors="replace")
            # Parse via pandapower safe json loader
            net = pp.from_json_string(text)
            if not grid_name:
                grid_name = Path(files[0].filename).stem

        # Case 3: ZIP archive containing CSVs or MATPOWER
        elif len(files) == 1 and files[0].filename.lower().endswith(".zip"):
            content_bytes = file_bytes_map[files[0].filename]

            with zipfile.ZipFile(io.BytesIO(content_bytes)) as z:
                namelist = z.namelist()
                # Check for .m file in zip
                m_files = [n for n in namelist if n.lower().endswith(".m") and not n.startswith("__MACOSX")]
                if m_files:
                    m_text = z.read(m_files[0]).decode("utf-8", errors="replace")
                    parsed_mpc = parse_matpower_text(m_text)
                    net = matpower_data_to_pandapower(parsed_mpc)
                    if not grid_name:
                        grid_name = Path(m_files[0]).stem
                else:
                    # Look for bus.csv and branch.csv
                    bus_csv = next((n for n in namelist if "bus" in n.lower() and n.lower().endswith(".csv")), None)
                    br_csv = next((n for n in namelist if ("branch" in n.lower() or "line" in n.lower()) and n.lower().endswith(".csv")), None)
                    gen_csv = next((n for n in namelist if "gen" in n.lower() and n.lower().endswith(".csv")), None)

                    if not bus_csv or not br_csv:
                        raise HTTPException(
                            status_code=400,
                            detail="ZIP archive must contain 'bus.csv' and 'branch.csv' (or a MATPOWER .m file)."
                        )

                    bus_df = pd.read_csv(io.BytesIO(z.read(bus_csv)))
                    br_df = pd.read_csv(io.BytesIO(z.read(br_csv)))
                    gen_df = pd.read_csv(io.BytesIO(z.read(gen_csv))) if gen_csv else None
                    net = parse_csv_grid_data(bus_df, br_df, gen_df)
                    if not grid_name:
                        grid_name = Path(files[0].filename).stem

        # Case 4: Multiple CSV files uploaded directly
        else:
            bus_df = None
            br_df = None
            gen_df = None

            for f in files:
                fname = (f.filename or "").lower()
                b_content = file_bytes_map[f.filename or "file"]
                if "bus" in fname and fname.endswith(".csv"):
                    bus_df = pd.read_csv(io.BytesIO(b_content))
                elif ("branch" in fname or "line" in fname) and fname.endswith(".csv"):
                    br_df = pd.read_csv(io.BytesIO(b_content))
                elif "gen" in fname and fname.endswith(".csv"):
                    gen_df = pd.read_csv(io.BytesIO(b_content))

            if bus_df is None or br_df is None:
                raise HTTPException(
                    status_code=400,
                    detail="CSV upload requires at least 'bus.csv' and 'branch.csv'."
                )

            net = parse_csv_grid_data(bus_df, br_df, gen_df)
            if not grid_name:
                grid_name = "Uploaded CSV Grid"

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse uploaded grid files: {str(e)}")

    if net is None:
        raise HTTPException(status_code=400, detail="Could not construct pandapower network from uploaded files.")

    # Validate and calibrate thermal ratings
    report = validate_and_calibrate_grid(net, grid_id=grid_id, grid_name=grid_name)

    if not report["valid"]:
        return JSONResponse(status_code=400, content=report)

    # Register in storage and cache layout
    register_uploaded_grid(grid_id, net, report)

    # Evaluate OOD status for newly uploaded grid
    ood = get_grid_ood_status(grid_id)
    report["ood_status"] = ood

    return report


@app.get("/grids", tags=["Grid Management"])
async def get_all_grids():
    """List all available built-in and uploaded grids with OOD status."""
    return list_available_grids()


@app.get("/grids/{grid_id}", tags=["Grid Management"])
async def get_grid_by_id_endpoint(grid_id: str):
    """Get metadata and OOD status for a specific grid."""
    try:
        meta = get_grid_metadata(grid_id)
        ood = get_grid_ood_status(grid_id)
        return {
            "metadata": meta,
            "ood_status": ood
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")


@app.get("/grids/{grid_id}/metadata", tags=["Grid Management"])
async def get_grid_metadata_endpoint(grid_id: str):
    """Get parsed metadata and comparison with training distribution."""
    try:
        meta = get_grid_metadata(grid_id)
        comparison = compare_grid_with_training_distribution(meta)
        return {
            "metadata": meta,
            "training_distribution_comparison": comparison
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")


@app.get("/grids/{grid_id}/topology", tags=["Grid Management"])
async def get_grid_topology_endpoint(grid_id: str):
    """
    Get topological analytics for a grid:
    - Per-bus nodal degree
    - Betweenness centrality
    - Community detection cluster ID
    - Critical bridge branches (cut-edges)
    - Number of islands (connected components)
    - Average degree and diameter
    Cached in-memory per grid.
    """
    try:
        return compute_grid_topology(grid_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to compute grid topology: {str(e)}")


@app.delete("/grids/{grid_id}", tags=["Grid Management"])
async def delete_grid_endpoint(grid_id: str):
    """Delete an uploaded custom grid and clear caches."""
    if grid_id in ("case30", "case118"):
        raise HTTPException(status_code=400, detail="Cannot delete built-in IEEE benchmark cases.")
    deleted = delete_uploaded_grid(grid_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")
    return {"status": "deleted", "grid_id": grid_id}


@app.get("/grids/{grid_id}/layout", tags=["Grid Management"])
async def get_grid_layout_endpoint(grid_id: str):
    """Get cached 3D coordinates layout for a specific grid."""
    try:
        return get_grid_3d_layout(grid_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")


@app.get("/grids/{grid_id}/layout2d", tags=["Grid Management"])
@app.get("/grid/{grid_id}/layout2d", tags=["Grid Management"])
async def get_grid_layout_2d_endpoint(grid_id: str):
    """Get cached 2D topological layout (Kamada-Kawai distance-stress layout) for a specific grid."""
    try:
        return compute_or_load_2d_layout(grid_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/grids/{grid_id}/stats", tags=["Grid Management"])
async def get_grid_statistics_endpoint(grid_id: str):
    """
    Get detailed electrical and topological statistics for a grid:
    - Component counts (buses, branches, gens, loads, transformers)
    - Total demand and generation (MW)
    - Average and max branch loading (% from base power flow)
    - Number of branches above 80% loading
    - Min and max bus voltages (p.u.)
    - Average node degree and single points of failure (bridge branches)
    - Bus-type counts and loading histogram
    """
    try:
        return compute_grid_statistics(grid_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grid '{grid_id}' not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to compute grid statistics: {str(e)}")


@app.post("/grids/{grid_id}/calibrate", tags=["Grid Management"])
async def calibrate_grid_endpoint(grid_id: str):
    """
    Extension point stub for fine-tuning / calibrating GNN on an uploaded grid.
    Returns 501 Not Implemented with message 'planned'.
    """
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={
            "status": "not_implemented",
            "message": "planned",
            "grid_id": grid_id,
            "detail": "Fine-tuning and calibration pipeline on custom uploaded grids is planned for a future release."
        }
    )


# ==============================================================================
# Template Downloads
# ==============================================================================

@app.get("/templates/csv", tags=["Templates"])
async def get_csv_template():
    """Return CSV schema templates for bus.csv, branch.csv, and gen.csv."""
    return {
        "bus_csv": {
            "columns": ["bus_id", "vn_kv", "type", "p_mw", "q_mvar"],
            "example_rows": [
                {"bus_id": 0, "vn_kv": 135.0, "type": "slack", "p_mw": 0.0, "q_mvar": 0.0},
                {"bus_id": 1, "vn_kv": 135.0, "type": "load", "p_mw": 21.7, "q_mvar": 12.7},
                {"bus_id": 2, "vn_kv": 135.0, "type": "generator", "p_mw": 0.0, "q_mvar": 0.0}
            ]
        },
        "branch_csv": {
            "columns": ["from_bus", "to_bus", "r_ohm", "x_ohm", "max_i_ka", "in_service"],
            "example_rows": [
                {"from_bus": 0, "to_bus": 1, "r_ohm": 1.82, "x_ohm": 7.29, "max_i_ka": 0.556, "in_service": 1},
                {"from_bus": 1, "to_bus": 2, "r_ohm": 5.46, "x_ohm": 14.58, "max_i_ka": 0.278, "in_service": 1}
            ]
        },
        "gen_csv": {
            "columns": ["bus_id", "p_mw", "vm_pu", "is_slack"],
            "example_rows": [
                {"bus_id": 2, "p_mw": 40.0, "vm_pu": 1.0, "is_slack": 0}
            ]
        }
    }


@app.get("/templates/matpower-example", tags=["Templates"])
async def get_matpower_template():
    """Return sample MATPOWER .m text structure."""
    sample_m = (
        "function mpc = case_example\n"
        "mpc.version = '2';\n"
        "mpc.baseMVA = 100.0;\n\n"
        "%% bus data: bus_i type Pd Qd Gs Bs area Vm Va baseKV zone Vmax Vmin\n"
        "mpc.bus = [\n"
        "    1   3   0       0       0   0   1   1.0   0   135   1   1.1   0.9;\n"
        "    2   1   21.7    12.7    0   0   1   1.0   0   135   1   1.1   0.9;\n"
        "    3   2   2.4     1.2     0   0   1   1.0   0   135   1   1.1   0.9;\n"
        "];\n\n"
        "%% generator data: bus Pg Qg Qmax Qmin Vg mBase status Pmax Pmin\n"
        "mpc.gen = [\n"
        "    1   25.0    0   50  -20   1.0   100   1   100   0;\n"
        "    3   15.0    0   40  -10   1.0   100   1   60    0;\n"
        "];\n\n"
        "%% branch data: fbus tbus r x b rateA rateB rateC ratio angle status\n"
        "mpc.branch = [\n"
        "    1   2   0.02   0.08   0   100   0   0   0   0   1;\n"
        "    2   3   0.05   0.20   0   80    0   0   0   0   1;\n"
        "    1   3   0.04   0.15   0   80    0   0   0   0   1;\n"
        "];\n"
    )
    return Response(content=sample_m, media_type="text/plain")


# ==============================================================================
# Live Early Warning & Predictive Analysis
# ==============================================================================

@app.post("/predict", tags=["Early Warning"])
async def run_predict(req: PredictRequest):
    """
    Run low-latency cascading failure early warning prediction.
    Strictly operates on the immediate t=0+ post-contingency AC power flow solution.

    Returns:
    - cascade_probability (0.0 to 1.0) and alert tier (Low, Medium, High)
    - confidence_margin to operational threshold
    - before_after delta comparisons (overload count, max loading, MW rerouted, violations)
    - feature_group_contribution (loading, voltage, load/gen, topology)
    - second_opinion from calibrated XGBoost baseline
    - deterministic, template-based dispatcher narrative
    - out-of-training-range (OOD) status and reasons
    - per-branch loading and saliency importance
    - per-bus post-contingency voltages
    - latency in milliseconds
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        result = predict(
            grid_case=grid_target,
            outaged_elements=req.outaged,
            load_scale=req.load_scale,
            modifications=req.modifications
        )
        # Ensure dictionary integer keys are strings for JSON serialization
        result["per_branch_loading"] = {str(k): v for k, v in result["per_branch_loading"].items()}
        result["per_branch_importance"] = {str(k): v for k, v in result["per_branch_importance"].items()}
        result["per_bus_voltage"] = {str(k): v for k, v in result["per_bus_voltage"].items()}
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failure: {str(e)}")


@app.post("/whatif-curve", tags=["Early Warning"])
async def run_whatif_curve(req: WhatIfRequest):
    """
    Evaluate risk trajectory curve across load multipliers (0.60 to 1.20 in 0.05 increments).
    Batched, cached, and optimized for sub-second chart rendering.
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        return compute_whatif_curve(
            grid_case=grid_target,
            outaged_elements=req.outaged,
            min_load=req.min_load,
            max_load=req.max_load,
            step=req.step
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"What-if curve computation failed: {str(e)}")


@app.post("/criticality-map", tags=["Risk Screening"])
async def run_criticality_map(req: CriticalityRequest):
    """
    Execute N-1 contingency screening across all branches and generators.
    Identifies the single most critical failure points in the power grid.
    Runs as a background task with live polling for large networks, or returns immediately if cached.
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        return start_criticality_analysis(
            grid_id=grid_target,
            load_scale=req.load_scale
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Criticality analysis failed: {str(e)}")


# ==============================================================================
# Dataset Card & Data Inspection
# ==============================================================================

@app.get("/dataset/card", tags=["Dataset"])
async def get_dataset_card_endpoint():
    """Return dataset card containing pipeline specifications and leakage audit."""
    return get_dataset_card_cached()


@app.get("/dataset/splits", tags=["Dataset"])
async def get_dataset_splits_endpoint():
    """Return train, validation, and test split details with leakage assertions."""
    card = get_dataset_card_cached()
    splits_audit = card.get("splits_and_leakage_audit", {})
    class_balance = splits_audit.get("class_balance_per_split", {})
    split_sizes = {
        name: {
            sub: data.get("total", 0)
            for sub, data in subsets.items()
        }
        for name, subsets in class_balance.items()
    }
    return {
        "headline_split": splits_audit.get("headline_split", "random"),
        "total_scenarios": card.get("scenario_counts", {}).get("total_simulated", 500),
        "split_sizes": split_sizes,
        "split_definitions": splits_audit.get("split_definitions", {}),
        "class_balance_per_split": class_balance,
        "leakage_assertions": splits_audit.get("leakage_assertions", {}),
        "zero_temporal_leakage_guarantee": splits_audit.get("zero_temporal_leakage_guarantee", "")
    }


@app.get("/dataset/features", tags=["Dataset"])
async def get_dataset_features_endpoint():
    """Return feature dictionary with unit, level, and zero-leakage confirmation."""
    return {
        "count": len(FEATURE_DICTIONARY),
        "features": FEATURE_DICTIONARY
    }


@app.get("/dataset/distribution", tags=["Dataset"])
async def get_dataset_distribution_endpoint(
    feature: str = Query(default="pre_contingency_load_mw"),
    split: str = Query(default="all")
):
    """Return histogram distribution of a continuous feature split by cascade class."""
    try:
        return get_feature_distribution(feature_name=feature, split=split)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/dataset/sample", tags=["Dataset"])
async def get_dataset_default_sample_endpoint(scenario_id: int = Query(default=0)):
    """Return features, graph snapshot, and outcome for a scenario (defaults to scenario 0)."""
    try:
        return get_scenario_sample(scenario_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/dataset/sample/{scenario_id}", tags=["Dataset"])
async def get_dataset_sample_endpoint(scenario_id: int):
    """Return features, graph snapshot, and outcome for a single scenario."""
    try:
        return get_scenario_sample(scenario_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/dataset/download", tags=["Dataset"])
async def download_dataset_endpoint(format: str = Query(default="csv")):
    """Download dataset scenarios or card in CSV or JSON format."""
    if format.lower() == "csv":
        if TABULAR_PATH.exists():
            df = pd.read_parquet(TABULAR_PATH)
            buf = io.StringIO()
            df.to_csv(buf, index=False)
            return Response(
                content=buf.getvalue(),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=gridwatch_tabular_dataset.csv"}
            )
        elif RAW_DATA_PATH.exists():
            df = pd.read_parquet(RAW_DATA_PATH)
            buf = io.StringIO()
            df.drop(columns=["first_state"], errors="ignore").to_csv(buf, index=False)
            return Response(
                content=buf.getvalue(),
                media_type="text/csv",
                headers={"Content-Disposition": "attachment; filename=gridwatch_scenarios.csv"}
            )
    elif format.lower() == "json":
        card = get_dataset_card_cached()
        return JSONResponse(
            content=card,
            headers={"Content-Disposition": "attachment; filename=gridwatch_dataset_card.json"}
        )
    raise HTTPException(status_code=400, detail="Invalid format. Supported: 'csv', 'json'")


# ==============================================================================
# Advanced Explainability, Mitigation & Agentic Chat
# ==============================================================================

@app.get("/insights/global", tags=["Explainability"])
async def get_global_insights_endpoint():
    """Return global calibration curve, top influential corridors, and error gallery."""
    return get_global_insights()


@app.post("/explain", tags=["Explainability"])
async def run_explain_endpoint(req: PredictRequest):
    """
    Detailed explainability analysis including counterfactuals, uncertainty,
    explanation fidelity, and explainer agreement.
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        res = predict(
            grid_case=grid_target,
            outaged_elements=req.outaged,
            load_scale=req.load_scale,
            include_explainability=True
        )
        return {
            "grid_id": grid_target,
            "outaged": req.outaged,
            "load_scale": req.load_scale,
            "cascade_probability": res["cascade_probability"],
            "alert_level": res["alert_level"],
            "top_influential_branches": res.get("top_influential_branches", []),
            "feature_group_contribution": res.get("feature_group_contribution", {}),
            "counterfactual": res.get("counterfactual"),
            "uncertainty": res.get("uncertainty"),
            "explanation_quality": res.get("explanation_quality")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Explanation analysis failed: {str(e)}")


@app.post("/mitigate", tags=["Mitigation"])
async def run_mitigate_endpoint(req: MitigateRequest):
    """
    Evaluate candidate mitigation actions ranked by predicted risk reduction,
    with optional physics-based simulation verification (verify=true).
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        return evaluate_mitigation_actions(
            grid_id=grid_target,
            outaged_elements=req.outaged,
            load_scale=req.load_scale,
            verify=req.verify
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Mitigation evaluation failed: {str(e)}")


@app.post("/chat", tags=["Agentic Chat"])
async def chat_endpoint(req: ChatRequest, request: Request):
    """
    Streaming agentic assistant for transmission operators.
    Uses whitelisted backend tools and provides deterministic offline fallback.
    """
    client_ip = request.client.host if request.client else "127.0.0.1"
    context_dict = {
        "grid_id": req.context.grid_id or req.context.case or "case30",
        "outaged": req.context.outaged or ["line_3"],
        "load_scale": req.context.load_scale or 1.0
    }
    messages_list = [{"role": m.role, "content": m.content} for m in req.messages]

    is_offline = (os.getenv("LLM_PROVIDER", "offline").lower().strip() in ["offline", ""] or not os.getenv("LLM_API_KEY", "").strip())
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "X-Chat-Mode": "offline" if is_offline else "online"
    }

    return StreamingResponse(
        stream_chat_response(messages_list, context_dict, client_ip=client_ip),
        media_type="text/event-stream",
        headers=headers
    )


@app.get("/criticality-map/{task_id}", tags=["Risk Screening"])
async def get_criticality_task(task_id: str):
    """Poll progress and retrieve results for a running criticality screening task."""
    try:
        return get_criticality_status(task_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Criticality task '{task_id}' not found.")


# ==============================================================================
# Simulation Replay (Decoupled Ground Truth)
# ==============================================================================

@app.post("/cascade-replay", tags=["Simulation"])
async def run_cascade_replay(req: CascadeReplayRequest):
    """
    Simulate step-by-step quasi-dynamic cascade propagation ground truth.

    CRITICAL ZERO-LEAKAGE SEPARATION:
    This endpoint executes the physical quasi-dynamic cascade simulator.
    Its step-by-step output is strictly for frontend visualization and is NEVER
    fed into the early warning model.
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        replay_result = simulate_cascade(
            grid_case=grid_target,
            outaged_elements=req.outaged,
            load_scale=req.load_scale,
            modifications=req.modifications
        )
        return replay_result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Simulation replay failure: {str(e)}")


@app.post("/suggest-fix", tags=["Mitigation"])
@app.post("/suggested-fix", tags=["Mitigation"])
async def suggest_fix_endpoint(req: SuggestFixRequest):
    """
    Search for minimal actionable counterfactual fix.
    If model and simulator disagree (e.g. actual_cascade is true), searches using
    the quasi-dynamic cascade simulator. Otherwise evaluates model risk trajectory.
    """
    grid_target = req.grid_id or req.case or "case30"
    try:
        current_risk = req.current_probability
        if current_risk is None:
            pred = predict(
                grid_case=grid_target,
                outaged_elements=req.outaged,
                load_scale=req.load_scale,
                include_explainability=False,
                modifications=req.modifications
            )
            current_risk = float(pred.get("cascade_probability", pred.get("probability", 0.0)))

        return compute_suggested_fix(
            grid_id=grid_target,
            outaged_elements=[str(e) for e in req.outaged],
            load_scale=req.load_scale,
            current_risk=current_risk,
            predict_fn=lambda g, o, s: predict(g, o, s, include_explainability=False, modifications=req.modifications),
            actual_cascade=req.actual_cascade,
            modifications=req.modifications,
            alert_threshold=0.35
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Suggest fix computation failed: {str(e)}")


# ==============================================================================
# Benchmarks & Results
# ==============================================================================

@app.get("/results", tags=["Evaluation & Benchmarks"])
async def get_results():
    """Return model comparison tables, ablations, baselines, and curve plots."""
    final_csv = RESULTS_DIR / "final_comparison.csv"
    ablations_csv = RESULTS_DIR / "ablations.csv"
    baselines_csv = RESULTS_DIR / "baselines.csv"
    sanity_json = RESULTS_DIR / "explanations" / "sanity_check.json"

    benchmarks = []
    if final_csv.exists():
        df_bench = pd.read_csv(final_csv)
        benchmarks = df_bench.fillna("").to_dict(orient="records")

    ablations = []
    if ablations_csv.exists():
        df_abl = pd.read_csv(ablations_csv)
        ablations = df_abl.fillna("").to_dict(orient="records")

    baselines = []
    if baselines_csv.exists():
        df_base = pd.read_csv(baselines_csv)
        baselines = df_base.fillna("").to_dict(orient="records")

    sanity_check = {}
    if sanity_json.exists():
        try:
            with open(sanity_json, "r", encoding="utf-8") as f:
                sanity_check = json.load(f)
        except Exception:
            pass

    available_curves = [f.name for f in RESULTS_DIR.glob("*.png")]

    return {
        "status": "success",
        "benchmark_comparison": benchmarks,
        "ablations": ablations,
        "baselines": baselines,
        "explainability_sanity_check": sanity_check,
        "curve_plots": available_curves
    }


@app.get("/results/curves/{curve_name}", tags=["Evaluation & Benchmarks"])
async def get_curve_image(curve_name: str):
    """Return evaluation ROC or PR curve PNG plot."""
    img_path = RESULTS_DIR / curve_name
    if not img_path.exists() or not img_path.is_file():
        raise HTTPException(status_code=404, detail=f"Plot '{curve_name}' not found.")
    return FileResponse(img_path, media_type="image/png")


# Legacy compatibility for direct /grid and /layout queries
@app.get("/grid", tags=["Topology"])
async def legacy_get_grid(case: str = Query("case30")):
    net = load_grid_by_id(case)
    slack_buses = set(net.ext_grid["bus"].values) if hasattr(net, "ext_grid") and len(net.ext_grid) > 0 else set()
    gen_buses = set(net.gen["bus"].values) if hasattr(net, "gen") and len(net.gen) > 0 else set()
    load_buses = set(net.load["bus"].values) if hasattr(net, "load") and len(net.load) > 0 else set()

    load_p = net.load.groupby("bus")["p_mw"].sum().to_dict() if hasattr(net, "load") and len(net.load) > 0 and "p_mw" in net.load.columns else {}
    load_q = net.load.groupby("bus")["q_mvar"].sum().to_dict() if hasattr(net, "load") and len(net.load) > 0 and "q_mvar" in net.load.columns else {}
    gen_p = net.gen.groupby("bus")["p_mw"].sum().to_dict() if hasattr(net, "gen") and len(net.gen) > 0 and "p_mw" in net.gen.columns else {}
    gen_q = net.gen.groupby("bus")["q_mvar"].sum().to_dict() if hasattr(net, "gen") and len(net.gen) > 0 and "q_mvar" in net.gen.columns else {}

    bus_offset = 1 if len(net.bus) > 0 and min(net.bus.index) == 0 else 0

    buses = []
    for b_id in net.bus.index:
        b_int = int(b_id)
        if b_int in slack_buses:
            b_type = "slack"
        elif b_int in gen_buses:
            b_type = "generator"
        elif b_int in load_buses:
            b_type = "load"
        else:
            b_type = "substation"

        buses.append({
            "id": b_int,
            "name": f"Bus {b_int + bus_offset}",
            "type": b_type,
            "vn_kv": float(net.bus.loc[b_id, "vn_kv"]) if "vn_kv" in net.bus else 135.0,
            "base_p_mw": float(load_p.get(b_int, 0.0)),
            "base_q_mvar": float(load_q.get(b_int, 0.0)),
            "gen_p_mw": float(gen_p.get(b_int, 0.0)),
            "gen_q_mvar": float(gen_q.get(b_int, 0.0))
        })

    branches = []
    for l_id in net.line.index:
        l_int = int(l_id)
        r_val = float(net.line.loc[l_id, "r_ohm_per_km"] * net.line.loc[l_id, "length_km"]) if "r_ohm_per_km" in net.line and "length_km" in net.line else 1.0
        x_val = float(net.line.loc[l_id, "x_ohm_per_km"] * net.line.loc[l_id, "length_km"]) if "x_ohm_per_km" in net.line and "length_km" in net.line else 2.5
        rating = float(net.line.loc[l_id, "max_i_ka"]) if "max_i_ka" in net.line else 1.0
        in_svc = bool(net.line.loc[l_id, "in_service"]) if "in_service" in net.line else True

        fb = int(net.line.loc[l_id, "from_bus"]) + bus_offset
        tb = int(net.line.loc[l_id, "to_bus"]) + bus_offset

        branches.append({
            "id": l_int,
            "name": f"Line {fb}-{tb}",
            "from_bus": int(net.line.loc[l_id, "from_bus"]),
            "to_bus": int(net.line.loc[l_id, "to_bus"]),
            "is_transformer": False,
            "rating": rating,
            "r_ohm": r_val,
            "x_ohm": x_val,
            "in_service": in_svc
        })

    return {
        "grid_case": case,
        "num_buses": len(buses),
        "num_branches": len(branches),
        "buses": buses,
        "branches": branches
    }


@app.get("/layout", tags=["Topology"])
async def legacy_get_layout(case: str = Query("case30")):
    return get_grid_3d_layout(case)


@app.get("/layout2d", tags=["Topology"])
async def legacy_get_layout2d(case: str = Query("case30")):
    return compute_or_load_2d_layout(case)


# ==============================================================================
# Maintenance Prioritisation & Outage Planning
# ==============================================================================

@app.post("/maintenance/priority", tags=["Maintenance"])
async def get_maintenance_priorities(req: MaintenancePriorityRequest):
    """
    Compute risk-based maintenance priorities for all grid transmission assets.
    Computes:
    - Consequence (cascade probability if asset is lost, reusing cached N-1 criticality map)
    - Stress (24h thermal loading profile: peak load, hours >80%, hours >100%)
    - Likelihood (transparent formula: 0.45*(1-cond) + 0.30*age/40 + 0.25*stress)
    - Priority = Likelihood x Consequence
    """
    grid_id = req.grid_id or req.case or "case30"
    try:
        results = compute_maintenance_priorities(grid_id, req.load_profile)
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to compute maintenance priorities: {str(e)}")


@app.post("/maintenance/planned-outage", tags=["Maintenance"])
async def plan_outage(req: PlannedOutageRequest):
    """
    Evaluate 24-hour planned maintenance outage window for an asset.
    Simulates taking the asset offline across the daily load cycle, predicts hourly risk,
    identifies safest and avoid windows, and performs cascade simulator verification.
    """
    grid_id = req.grid_id or req.case or "case30"
    try:
        evaluation = evaluate_planned_outage(grid_id, req.asset_id, req.load_profile)
        return evaluation
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to evaluate planned outage: {str(e)}")


@app.get("/maintenance/assets/template", tags=["Maintenance"])
async def download_asset_template():
    """Download standard CSV template for custom asset health and age data."""
    csv_data = get_asset_template_csv()
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=asset_data_template.csv"}
    )


@app.post("/maintenance/assets/upload", tags=["Maintenance"])
async def upload_asset_table(
    file: UploadFile = File(...),
    grid_id: str = Query("case30", description="Target grid identifier")
):
    """
    Upload custom asset condition, age, and inspection records CSV for a grid.
    Required columns: asset_id, age_years, condition_score, last_inspection_date
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files (.csv) are accepted for asset data.")
    
    content_bytes = await file.read()
    if len(content_bytes) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="Asset CSV exceeds 5 MB limit.")

    try:
        csv_str = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        try:
            csv_str = content_bytes.decode("latin-1")
        except Exception:
            raise HTTPException(status_code=400, detail="Failed to decode CSV text.")

    try:
        assets = save_uploaded_asset_data(grid_id, csv_str)
        return {
            "status": "success",
            "grid_id": grid_id,
            "source": "uploaded",
            "count": len(assets),
            "message": f"Successfully uploaded and registered {len(assets)} asset records for {grid_id}."
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid asset CSV format: {str(e)}")


@app.get("/maintenance/assets/{grid_id}", tags=["Maintenance"])
async def get_grid_asset_records(grid_id: str):
    """Retrieve all asset health records for a grid (indicates simulated vs uploaded)."""
    assets, source = get_grid_assets(grid_id)
    return {
        "grid_id": grid_id,
        "source": source,
        "is_simulated": (source == "simulated"),
        "label": "Simulated asset data" if source == "simulated" else "Uploaded asset data",
        "count": len(assets),
        "assets": assets
    }


# ==============================================================================
# Notifications & Alerting Rules
# ==============================================================================

@app.get("/notifications/settings", tags=["Notifications"])
async def get_settings():
    """Get current notification settings, confirmed recipients, and SMTP status."""
    return get_notification_settings()


@app.post("/notifications/settings", tags=["Notifications"])
async def update_settings(req: NotificationSettingsRequest):
    """Update notification settings and confirmed recipients."""
    updated = update_notification_settings(
        confirmed_recipients=req.confirmed_recipients,
        digest_frequency=req.digest_frequency,
        digest_recipients=req.digest_recipients
    )
    return updated


@app.get("/notifications/rules", tags=["Notifications"])
async def get_all_rules():
    """List all watchlist and alerting rules."""
    return {"rules": list_rules()}


@app.post("/notifications/rules", tags=["Notifications"])
async def create_new_rule(req: NotificationRuleRequest):
    """Create a new watchlist alerting rule."""
    try:
        rule = create_rule(
            name=req.name,
            rule_type=req.rule_type,
            recipients=req.recipients,
            grid_id=req.grid_id or "case30",
            threshold=req.threshold if req.threshold is not None else 0.5,
            load_scale=req.load_scale if req.load_scale is not None else 1.0,
            scenario_outages=req.scenario_outages,
            cooldown_hours=req.cooldown_hours if req.cooldown_hours is not None else 6.0,
            enabled=req.enabled if req.enabled is not None else True
        )
        return rule
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/notifications/rules/{rule_id}", tags=["Notifications"])
async def remove_rule(rule_id: str):
    """Delete an existing notification rule."""
    success = delete_rule(rule_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} not found.")
    return {"status": "deleted", "rule_id": rule_id}


@app.post("/notifications/run-check-now", tags=["Notifications"])
async def run_check_now():
    """Trigger an immediate evaluation of all active notification rules."""
    eval_results = evaluate_rules(force=True)
    return {
        "status": "completed",
        "timestamp": time.time(),
        "evaluations": eval_results
    }


@app.post("/notifications/test", tags=["Notifications"])
async def send_test(req: TestEmailRequest):
    """Send an immediate test email (or write to outbox in demo mode)."""
    try:
        result = send_test_email(req.recipient)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send test email: {str(e)}")


@app.post("/notifications/digest", tags=["Notifications"])
async def send_digest(req: DigestEmailRequest):
    """Send a grid status summary digest email."""
    try:
        result = send_digest_email(recipients=req.recipients, grid_id=req.grid_id or "case30")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send digest email: {str(e)}")


@app.get("/notifications/outbox", tags=["Notifications"])
async def get_outbox():
    """List all saved emails in Outbox Demo Mode."""
    return {"emails": list_outbox_emails()}


@app.get("/notifications/outbox/{email_id}", tags=["Notifications"])
async def get_single_outbox_email(email_id: str):
    """Fetch a rendered email by ID from Outbox."""
    email_data = get_outbox_email(email_id)
    if not email_data:
        raise HTTPException(status_code=404, detail="Email not found in outbox.")
    return email_data


@app.get("/notifications/history", tags=["Notifications"])
async def get_history():
    """Retrieve history log of rule evaluations and notification dispatches."""
    return {"history": get_notification_history()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.api:app", host="0.0.0.0", port=8000, reload=False)
