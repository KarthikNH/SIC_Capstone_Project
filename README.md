# Gridwatch (Grid Site): Graph-Based Early Warning System for Cascading Failures

A deep learning early warning service for power transmission systems. Using a Graph Isomorphism Network with Edge features (**GINE**), Gridwatch predicts whether an initial $N-1$ or $N-2$ line/generator outage will trigger a catastrophic cascading failure across the grid.

---

## ⚡ Core Principles & Architecture

1. **Grid as a Graph:**
   - **Nodes (Buses):** Voltage magnitude, voltage angle, active/reactive load, active/reactive generation, bus type (PQ, PV, Slack), and outaged endpoint flags.
   - **Edges (Branches):** Active/reactive power flows, line loading percentage, resistance, reactance, thermal rating, in-service status, and pre/post contingency delta features ($\Delta V$, $\Delta \text{loading}$).
2. **Strict Zero-Leakage Guarantee:**
   - The model operates **exclusively** on information available at $t = 0^+$ (the immediate post-contingency AC power flow solution), before any cascade propagation occurs.
   - Any feature derived from subsequent tripping iterations or islanding is strictly forbidden in model training and inference.
   - The step-by-step quasi-dynamic cascade simulator is fully isolated and exposed via `/cascade-replay` for ground-truth visualization only.
3. **High-Performance Live Backend:**
   - Sub-50ms end-to-end inference and attribution latency on both IEEE 30-bus and IEEE 118-bus systems, enabling interactive live slider manipulation in web frontends.

---

## 🚀 Getting Started

### 1. Installation

```bash
pip install -r requirements.txt
```

### 2. Launch FastAPI Backend Service

```bash
python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
```

Interactive Swagger / OpenAPI docs are available at: `http://localhost:8000/docs`.

#### ⚠️ Windows Startup Check: Resolving Port 8000 In Use
If you encounter `[Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000)` or `address already in use`:

1. **Find the process using port 8000 (PowerShell):**
   ```powershell
   Get-NetTCPConnection -LocalPort 8000 | Select-Object OwningProcess, LocalAddress, LocalPort, State
   ```
   *(Or in Command Prompt: `netstat -ano | findstr :8000`)*

2. **Terminate the process holding port 8000:**
   ```powershell
   Stop-Process -Id <PID> -Force
   ```
   *(Or in Command Prompt: `taskkill /PID <PID> /F`)*

3. **Verify the port is released and restart uvicorn:**
   ```powershell
   python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
   ```


### 3. Launch React + Vite Interactive Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. The Vite dev server automatically proxies `/grid`, `/layout`, `/predict`, `/cascade-replay`, and `/results` to the FastAPI backend.

---

## 📡 API Endpoints & Example Requests

### 1. Health & Project Metadata (`GET /`)
```bash
curl -X GET "http://localhost:8000/"
```

### 2. Grid Topology (`GET /grid`)
Retrieves buses, electrical roles (slack, generator, load, substation), base load/generation, and branches with thermal ratings.
```bash
curl -X GET "http://localhost:8000/grid?case=case30"
```

### 3. 3D Coordinates Layout (`GET /layout`)
Retrieves cached 3D force-directed coordinates for buses with vertical layering stratified by nominal voltage levels ($V_n$).
```bash
curl -X GET "http://localhost:8000/layout?case=case30"
```

### 4. Live Early Warning Prediction (`POST /predict`)
Evaluates an $N-1$ or $N-2$ contingency under scaled load, executing AC power flow and GINE inference.

```bash
curl -X POST "http://localhost:8000/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "case": "case30",
    "outaged": ["line_9"],
    "load_scale": 1.18
  }'
```

**Example Response:**
```json
{
  "grid_case": "case30",
  "outaged_elements": ["line_9"],
  "load_scale": 1.18,
  "cascade_probability": 0.9854,
  "alert_level": "High",
  "summary": "Critical: Outage is highly likely to trigger cascading failures and load shedding.",
  "power_flow_converged": true,
  "total_pre_load_mw": 341.26,
  "top_influential_branches": [
    {
      "branch_id": 9,
      "name": "Line 5-7",
      "loading_percent": 112.4,
      "importance": 1.0
    },
    {
      "branch_id": 8,
      "name": "Line 4-12",
      "loading_percent": 88.6,
      "importance": 0.62
    },
    {
      "branch_id": 7,
      "name": "Line 2-6",
      "loading_percent": 79.1,
      "importance": 0.44
    }
  ],
  "latency_ms": 49.3,
  "cached": false
}
```

### 5. What-If Risk Curve (`POST /whatif-curve`)
Evaluates risk trajectory from load scale 0.60 to 1.20 in steps of 0.05 for a disturbance.

```bash
curl -X POST "http://localhost:8000/whatif-curve" \
  -H "Content-Type: application/json" \
  -d '{
    "grid_id": "case30",
    "outaged": ["line_3"],
    "min_load": 0.60,
    "max_load": 1.20,
    "step": 0.05
  }'
```

### 6. Automated Criticality Map (`POST /criticality-map`)
Screens every single branch and generator in the network (N-1 screening) to identify top single points of failure.

```bash
curl -X POST "http://localhost:8000/criticality-map" \
  -H "Content-Type: application/json" \
  -d '{
    "grid_id": "case30",
    "load_scale": 1.0
  }'
```

Poll progress via: `GET http://localhost:8000/criticality-map/{task_id}`.

### 7. Grid Upload & Management (`POST /grids/upload`)
Secure multipart upload for MATPOWER `.m`, pandapower JSON, or CSVs (`bus.csv`, `branch.csv`).
- Strict security: pure text parsing, no `eval`, no `exec`, no unpickling.
- Enforces 5 MB file size limit and 500-bus capacity cap.
- Automatic AC power flow validation, island detection, and derived branch thermal ratings.

```bash
curl -X POST "http://localhost:8000/grids/upload?grid_name=My%20Grid" \
  -F "files=@case57.m"
```

### 8. Grid Statistics (`GET /grids/{id}/stats`)
Retrieves comprehensive graph and electrical statistics (bus types, bridges, loading histogram, demand/gen totals).

```bash
curl -X GET "http://localhost:8000/grids/case30/stats"
```

### 9. Ground-Truth Cascade Replay (`POST /cascade-replay`)
Executes quasi-dynamic cascading line tripping due to thermal overloads. **Visualization only; strictly isolated from model.**

```bash
curl -X POST "http://localhost:8000/cascade-replay" \
  -H "Content-Type: application/json" \
  -d '{
    "case": "case30",
    "outaged": ["line_9"],
    "load_scale": 1.18
  }'
```

### 10. Model Comparison & Benchmarks (`GET /results`)
Retrieves benchmark tables across random and contingency-held-out splits, ablation studies, and curve figures.

```bash
curl -X GET "http://localhost:8000/results"
```

---

## 🧪 Benchmark Comparison on Unseen Contingencies

Performance evaluated on the **Contingency-Held-Out Split** (zero overlap between training and test disturbances):

| Model | Accuracy | PR-AUC | ROC-AUC | Recall (Cascades Caught) | False Alarm Rate (FPR) | Operating Threshold |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **GINE (Graph Neural Network)** | **87.6%** | **0.9308** | **0.9645** | **97.3%** | 18.0% | 0.272 |
| **Random Forest** | 97.1% | 0.9677 | 0.9850 | 97.3% | 3.1% | 0.330 |
| **XGBoost** | 97.1% | 0.9623 | 0.9834 | 100.0% | 4.6% | 0.050 |
| **Logistic Regression** | 95.1% | 0.9018 | 0.9705 | 100.0% | 7.7% | 0.195 |
| **Rule-Based Loading Heuristic** | 93.1% | 0.9016 | 0.9705 | 100.0% | 10.8% | 0.490 |
| **Dense MLP** | 88.2% | 0.8867 | 0.9551 | 97.3% | 16.9% | 0.325 |

*Note: While tabular ensembles rely on global hand-engineered aggregations (`max_line_loading`), GINE operates directly on raw local topology and provides branch-level spatial attribution for operator root-cause analysis.*

---

## 🛡️ Test Suites

Execute the API integration test suites:

```bash
# Phase 1 endpoint extensions, leakage assertions, and latency benchmarks
python -m pytest tests/test_backend_phase1_extensions.py -v

# Core API and grid upload tests
python -m pytest tests/test_api_phase1.py -v
```

---

## 🛰️ Extended Backend Endpoints (Phase 1)

### 1. Dataset Card & Feature Inspection
- `GET /dataset/card`: Comprehensive dataset metadata, simulator thresholds ($K=3, 15\%$ shed), class balances, and leakage audit results.
- `GET /dataset/features`: Machine-readable feature dictionary confirming strictly $t=0^+$ post-contingency provenance.
- `GET /dataset/distribution?feature=pre_contingency_load_mw&split=all`: Histogram distribution split by cascade outcome.
- `GET /dataset/sample/{scenario_id}`: Inspect features, graph topology, and label outcome of an individual scenario.
- `GET /dataset/download?format=csv|json`: Export tabular features or dataset card.

### 2. Topology Analytics & Centrality
- `GET /grids/{id}/topology`: Returns nodal degree, betweenness centrality, community partition ID, critical bridge cut-edges, island count, average degree, and diameter (cached per grid).
- `GET /grids/{id}/metadata`: Parsed component counts and comparison against training distribution envelopes.

### 3. Explainability, Uncertainty & Counterfactuals
- `POST /predict`: Upgraded response includes:
  - `counterfactual`: Smallest operator action (load curtailment, line uprating) that brings risk below alert threshold.
  - `uncertainty`: MC dropout confidence interval (mean, std, 95% CI low/high, confidence margin).
  - `explanation_quality`: Fidelity (risk drop when top-k branches are relieved) and network sparsity score.
  - `explainer_agreement`: Top-k overlap score between GNNExplainer vs gradient saliency.
- `POST /explain`: Dedicated endpoint for comprehensive attribution diagnostics.
- `GET /insights/global`: Calibration curves across probability deciles, top influential corridors, and error gallery (audited false positives/negatives).

### 4. Operator Mitigation Evaluation
- `POST /mitigate`: Evaluates candidate mitigation actions with the GINE model, ranked by predicted risk drop.
  - When `verify=true`, automatically re-runs the physics-based cascade simulator on top 3 actions to verify prevention (`simulator verified` vs `model estimate`).

### 5. Agentic Operator Chat (Streaming SSE)
- `POST /chat`: Streaming decision support assistant with tool-calling whitelist (`get_prediction`, `get_topology`, `suggest_mitigation`, `get_dataset_card`, etc.).
  - Configurable via `.env`: `LLM_PROVIDER` (`gemini`, `openai`, `anthropic`, `ollama`, or `offline`).
  - Strict Prompt Injection Defense: Treats all uploaded grid names, comments, and file strings as passive untrusted data.
  - Deterministic Offline Fallback: If no API key is provided, answers common operator intents deterministically with backend tools.

---

## 📂 Grid Ingestion, Supported Formats & Security

Gridwatch supports dynamic ingestion of custom power grid topologies alongside built-in IEEE 30-bus and IEEE 118-bus models.

### 1. Supported Formats
- **MATPOWER (`.m`)**: Text format containing standard `mpc.bus`, `mpc.gen`, and `mpc.branch` matrices. Download example via `GET /templates/matpower-example`.
- **Pandapower JSON (`.json`)**: Exported pandapower network dictionary.
- **CSV Archive (`.zip` or individual files)**:
  - `bus.csv`: Columns `[bus_id, vn_kv, type, p_mw, q_mvar]`
  - `branch.csv`: Columns `[from_bus, to_bus, r_ohm, x_ohm, max_i_ka, in_service]`
  - `gen.csv` (optional): Columns `[bus, p_mw, vm_pu, max_p_mw, min_p_mw]`
  - Download schema via `GET /templates/csv`.

### 2. Strict Security Architecture
- **No Arbitrary Code Execution**: Files are parsed strictly as numerical text tables or structured JSON. Neither `eval()`, `exec()`, nor shell subprocesses are ever invoked.
- **Zero Object Unpickling**: Python `pickle.load()` is strictly prohibited during ingestion to prevent arbitrary object deserialization exploits.
- **Payload & Size Constraints**: Hard limit of **5 MB** per upload payload and **500 buses** maximum network size to prevent memory exhaustion and denial-of-service.

### 3. Out-Of-Distribution (OOD) Reliability Notice & Known Limitations
- **Training Envelope**: The early warning GINE model was trained and calibrated on standardized transmission benchmarks (IEEE 30-bus and IEEE 118-bus).
- **Automated OOD Detection**: Upon ingestion, `/grids/{id}` evaluates network size, degree distributions, feature quantiles, and graph embedding centroid distances.
- **Operator Reliability Banner**: Any grid with `borderline` or `outside` OOD status displays an unmistakable warning banner in the interface:
  > *"Outside the range this model was trained on. Treat this prediction as less reliable."*
- **Model Calibration**: Custom model fine-tuning per uploaded grid (`POST /grids/{id}/calibrate`) is an extension point currently stubbed with HTTP 501 ("planned").

---

## 🎨 Interactive Front-End Features (Phase 2)

The user interface adheres strictly to the **Estate** architectural light theme, preserving clean typographic hierarchies, high contrast, and uncluttered layout with responsive tabs and drawers:

### 1. 3D | Map View Switch & Topology Overlays
- **Animated 3D ↔ Map Transition**: Toggle between an interactive 3D spatial transmission mesh and a 2D top-down Map view. In Map mode, buses smoothly glide into stratified horizontal bands grouped by nominal voltage levels ($V_n$).
- **Topological Overlays**:
  - **Nodal Degree**: Nodes colored and scaled by connectivity degree from cyan (low) to amber to crimson (hubs).
  - **Betweenness Centrality**: Nodes highlighted by electrical choke-point traffic from indigo to magenta.
  - **Community Clusters**: Spectral graph communities rendered in distinct palette clusters.
  - **Bridge Cut-Edges**: Critical single-point-of-failure lines whose loss islands the network are illuminated in bold golden amber.
- **Topology Stats Card**: Quick HUD display in Map mode showing average nodal degree, bridge cut-edge count, island count, and network diameter directly from `/grids/{id}/topology`.

### 2. Dataset Inspector ("Data" Tab)
- **Pipeline & Simulator Overview**: Metrics from `/dataset/card` including scenario counts, contingency type ratios, load scaling bounds, cascade labeling rules, and AC Newton-Raphson simulator settings.
- **Leakage Audit Badges**: Clear pass/fail badges confirming random split disjoint subsets, zero held-out contingency leakage, and strict $t=0^+$ post-contingency zero-temporal-leakage invariants.
- **Searchable Feature Dictionary**: Full interactive dictionary from `/dataset/features` with instantaneous search by name, unit, or description, filtered by node/edge entity, and displaying the $t=0^+$ provenance badge.
- **Density Distribution Viewer**: Dual-series class-separated histograms comparing safe vs cascade distributions across splits and individual physical quantities.
- **Single Scenario Browser**: Enter any scenario ID ($0–499$) to inspect pre-cascade bus and branch electrical snapshots and verify zero downstream contamination.
- **Export Capabilities**: Direct one-click download buttons for the Dataset Card (JSON) and full scenario feature table (CSV).
- **Uploaded Grid Comparison**: Displays domain distribution compatibility envelopes and closest reference grid matches for uploaded grids.

### 3. Explainable AI (XAI) & Model Insights ("Why" Tab)
- **Counterfactual Action Card**: Computes the smallest physical intervention (e.g., specific load curtailment or line restoration) that returns the contingency below alert threshold, with before/after risk scores and a one-click **"Apply Counterfactual Fix"** button.
- **Confidence Intervals**: 95% confidence intervals from MC-dropout displayed prominently beside the predicted risk score.
- **Explanation Quality Badge**: Quantified attribution metrics covering fidelity risk drop, explanation sparsity, and explainer agreement (GNNExplainer vs Integrated Gradients overlap).
- **Collapsible Model Insights**:
  - Global reliability calibration diagram (Brier score and decile frequency bars).
  - Most frequently saliency-critical transmission corridors across the test set.
  - Audited Error Gallery of false positives and false negatives, each with an **"Open in Scene"** button that instantly configures the grid, outage, and load scale in the 3D scene.

### 4. Grid Assistant Chatbot Side Drawer
- **Persistent AI Assistant**: Floating bottom-right launcher button opening a sleek side drawer.
- **Streaming Decision Support**: Real-time SSE streaming from `/chat` with suggested prompt chips (*"Why is the risk high?"*, *"Suggest a fix"*, *"What does this dataset contain?"*).
- **Automatic Context Propagation**: Sends active grid ID, selected outages, and load scale with every request.
- **Structured Tool Rendering**: Formats tool outputs as interactive cards, before/after risk tables, and ranked mitigation countermeasures labeled `model estimate` vs `simulator verified`.
- **Physical Verification**: One-click **"Verify in Simulator"** button that runs the physical cascade engine via `POST /mitigate?verify=true` and updates the card live.
- **Bidirectional UI Actions**: Executes actions returned by the assistant (setting load sliders, tripping lines, switching tabs, enabling criticality overlays) with confirmation notifications.


