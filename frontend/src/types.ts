export type BusType = 'generator' | 'slack' | 'load' | 'substation';

export interface Bus {
  id: number;
  name: string;
  type: BusType;
  vn_kv: number;
  base_p_mw: number;
  base_q_mvar: number;
  gen_p_mw: number;
  gen_q_mvar: number;
}

export interface Branch {
  id: number;
  name: string;
  from_bus: number;
  to_bus: number;
  is_transformer: boolean;
  rating: number;
  r_ohm: number;
  x_ohm: number;
  in_service: boolean;
}

export interface BusLayout {
  bus_id: number;
  x: number;
  y: number;
  z: number;
  vn_kv: number;
  type: string;
  degree: number;
}

export interface LayoutResponse {
  grid_case: string;
  num_buses: number;
  num_branches: number;
  buses: BusLayout[];
  branches: { from_bus: number; to_bus: number }[];
  bus_map: Record<string, BusLayout>;
}

export interface GridResponse {
  grid_case: string;
  num_buses: number;
  num_branches: number;
  buses: Bus[];
  branches: Branch[];
}

export interface InfluentialBranch {
  branch_id: number;
  name: string;
  loading_percent: number;
  importance: number;
}

export interface BeforeAfterDelta {
  overloaded_branches_before: number;
  overloaded_branches_after: number;
  max_loading_before: number;
  max_loading_after: number;
  mw_rerouted: number;
  voltage_violations: number[];
  islanded_buses: number[];
}

export interface FeatureGroupContribution {
  loading: number;
  voltage: number;
  load_generation: number;
  topology: number;
}

export interface SecondOpinion {
  model: string;
  probability: number;
  operating_threshold: number;
  agrees: boolean;
  discrepancy: number;
  message: string;
}

export interface OodStatus {
  status: 'in_range' | 'borderline' | 'outside';
  confidence_penalty: number;
  reasons: string[];
  metrics_evaluated: {
    num_buses: number;
    embedding_distance: number | null;
  };
}

export interface PredictResponse {
  grid_case: string;
  outaged_elements: string[];
  load_scale: number;
  probability?: number;
  cascade_probability: number;
  alert_level: 'Low' | 'Medium' | 'High';
  alert_threshold?: number;
  operating_threshold?: number;
  predicted_cascade?: boolean;
  summary: string;
  narrative?: string;
  confidence_margin?: number;
  power_flow_converged: boolean;
  total_pre_load_mw: number;
  before_after?: BeforeAfterDelta;
  feature_group_contribution?: FeatureGroupContribution;
  second_opinion?: SecondOpinion;
  ood_status?: OodStatus;
  counterfactual?: CounterfactualInfo;
  uncertainty?: UncertaintyInfo;
  explanation_quality?: ExplanationQualityInfo;
  per_branch_loading: Record<string, number>;
  per_branch_importance: Record<string, number>;
  per_bus_voltage: Record<string, number>;
  top_influential_branches: InfluentialBranch[];
  latency_ms: number;
  cached: boolean;
}

export interface GridStats {
  grid_id: string;
  counts: {
    buses: number;
    branches: number;
    generators: number;
    loads: number;
    transformers: number;
  };
  total_demand_mw: number;
  total_generation_mw: number;
  average_branch_loading_percent: number;
  max_branch_loading_percent: number;
  branches_above_80_percent: number;
  voltage_min_pu: number;
  voltage_max_pu: number;
  average_degree: number;
  num_bridge_branches: number;
  bus_type_counts: {
    slack: number;
    generator: number;
    load: number;
    substation: number;
  };
  loading_histogram: Array<{ bin: string; count: number }>;
}

export interface CascadeReplayStep {
  step: number;
  description: string;
  newly_tripped_branches: number[];
  cumulative_tripped_branches: number[];
  cumulative_extra_trips?: number;
  cumulative_load_shed_mw?: number;
  cumulative_load_shed_fraction?: number;
  cumulative_isolated_buses?: number[];
  max_loading_percent: number;
  branch_loadings: Record<string, number>;
  bus_voltages: Record<string, number>;
  islanded_buses: number[];
  load_shed_mw: number;
  load_shed_fraction: number;
  converged: boolean;
  status: string;
}

export interface CascadeReplayResponse {
  grid_case: string;
  outaged_elements: string[];
  load_scale: number;
  total_steps: number;
  cascade: number;
  actual_cascade?: boolean;
  cascade_criterion?: 'extra_trips' | 'load_shed' | 'both' | 'diverged' | 'none';
  criterion_explanation?: string;
  k_extra_trips?: number;
  load_shed_threshold?: number;
  additional_trips: number;
  final_load_shed_fraction: number;
  final_load_shed_mw: number;
  final_isolated_buses_count?: number;
  termination_reason: string;
  steps: CascadeReplayStep[];
}

export interface SuggestedFix {
  action_type: string;
  title: string;
  description?: string;
  plain_text: string;
  label: 'model estimate' | 'simulator verified';
  disagreement_resolved?: boolean;
  target_load_scale?: number;
  before_numbers?: {
    load_scale?: number;
    load_pct?: number;
    risk?: number;
    risk_pct?: number;
    cascade?: boolean;
    status?: string;
  };
  after_numbers?: {
    load_scale?: number;
    load_pct?: number;
    risk?: number;
    risk_pct?: number;
    cascade?: boolean;
    status?: string;
    extra_trips?: number;
    load_shed_pct?: number;
  };
  action?: {
    type: 'load_scale' | 'modifications';
    target_value?: number;
    delta_pct?: number;
    modifications?: Record<string, any>;
  };
  success: boolean;
  next_best_options?: Array<{
    title: string;
    plain_text: string;
    action?: any;
  }>;
}

export interface SplitSubsetStats {
  total: number;
  percentage: number;
  positive_cascade: number;
  negative_safe: number;
  cascade_rate: number;
  unique_contingencies: number;
}

export interface SplitLeakageAssertion {
  disjoint_subsets: boolean;
  complete_coverage: boolean;
  zero_scenario_leakage: boolean;
  contingency_overlap_between_train_and_eval: number;
  contingency_leakage_free: boolean;
}

export interface DatasetSplitsResponse {
  headline_split: string;
  total_scenarios: number;
  split_definitions: Record<string, string>;
  class_balance_per_split: Record<string, {
    train: SplitSubsetStats;
    val: SplitSubsetStats;
    test: SplitSubsetStats;
  }>;
  leakage_assertions: Record<string, SplitLeakageAssertion>;
  zero_temporal_leakage_guarantee: string;
}

export interface BenchmarkRow {
  Split: string;
  Model: string;
  Accuracy: string;
  Precision: string;
  Recall: string;
  F1: string;
  'F2 (Recall-Favored)'?: string;
  'ROC-AUC': string;
  'PR-AUC': string;
  'False Alarm Rate (FPR)': string;
  'Miss Rate (FNR)': string;
  'Operating Threshold': string | number;
  'Best Params'?: string;
}

export interface ResultsResponse {
  status: string;
  benchmark_comparison: BenchmarkRow[];
  ablations: any[];
  baselines: any[];
  explainability_sanity_check: {
    num_evaluated_graphs?: number;
    top_k?: number;
    mean_overlap_with_most_loaded_branches?: number;
    mean_overlap_with_electrically_closest_branches?: number;
    combined_physical_relevance_score?: number;
  };
  curve_plots: string[];
}

export interface GridListItem {
  id: string;
  name: string;
  is_builtin: boolean;
  num_buses: number;
  num_branches: number;
  ac_converged: boolean;
  ood_status: OodStatus;
}

export interface UploadGridResponse {
  grid_id: string;
  grid_name: string;
  num_buses: number;
  num_branches: number;
  num_generators: number;
  num_loads: number;
  ac_converged: boolean;
  ood_status: OodStatus;
  report: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    details: {
      slack_bus: boolean;
      connected: boolean;
      num_islands: number;
      islands: number[][];
      ac_power_flow_converged: boolean;
      base_mva_sensible: boolean;
      ratings_present: boolean;
      ratings_derived_assumed: boolean;
    };
  };
}

export interface WhatIfPoint {
  load_scale: number;
  load_percent: number;
  cascade_probability: number;
  alert_level: string;
  ac_converged: boolean;
}

export interface WhatIfResponse {
  grid_case: string;
  outaged_elements: string[];
  points: WhatIfPoint[];
  current_point?: WhatIfPoint;
}

export interface CriticalElement {
  element: string;
  element_type: string;
  from_bus?: number;
  to_bus?: number;
  risk_score: number;
  risk_level: string;
  loading_percent?: number;
}

export interface CriticalityResponse {
  task_id: string;
  grid_id: string;
  load_scale: number;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  total_elements?: number;
  processed_elements?: number;
  most_critical_elements?: CriticalElement[];
  branch_risk_map?: Record<string, number>;
}

// -----------------------------------------------------------------------------
// Phase 2: Explainability & Uncertainty Types
// -----------------------------------------------------------------------------
export interface CounterfactualInfo {
  action_type: string;
  recommended_load_scale?: number;
  outage_to_restore?: string;
  risk_before: number;
  risk_after: number;
  risk_reduction: number;
  explanation: string;
}

export interface UncertaintyInfo {
  mean_probability: number;
  standard_deviation: number;
  ci_95_low: number;
  ci_95_high: number;
  confidence_margin: number;
  method?: string;
}

export interface ExplanationQualityInfo {
  fidelity_risk_drop: number;
  sparsity_score: number;
  explainer_agreement: {
    gnn_vs_gradient_overlap_score: number;
    metric?: string;
  };
  plain_explanation: string;
}

// -----------------------------------------------------------------------------
// Phase 2: Topology Analytics Types
// -----------------------------------------------------------------------------
export interface BridgeBranchItem {
  branch_id: number;
  name: string;
  from_bus: number;
  to_bus: number;
}

export interface TopologyData {
  grid_id: string;
  num_buses: number;
  num_branches: number;
  num_islands: number;
  average_degree: number;
  diameter: number;
  num_bridge_branches: number;
  bridge_branches: BridgeBranchItem[];
  per_bus_degree: Record<string, number>;
  per_bus_betweenness: Record<string, number>;
  per_bus_community: Record<string, number>;
  communities?: Record<string, number[]>;
}

// -----------------------------------------------------------------------------
// Phase 2: Grid Metadata & Comparison Types
// -----------------------------------------------------------------------------
export interface GridMetadataComparison {
  distribution_status: 'in_range' | 'borderline' | 'outside';
  confidence_penalty: number;
  reasons: string[];
  comparison: {
    bus_count: number;
    training_bus_envelope: [number, number];
    branch_count: number;
    training_branch_envelope: [number, number];
    branch_to_bus_ratio: number;
    training_ratio_envelope: [number, number];
    average_degree: number;
    training_degree_envelope: [number, number];
  };
  closest_training_grid: string;
  notes: string;
}

export interface GridMetadataResponse {
  grid_id: string;
  metadata: {
    grid_id?: string;
    id?: string;
    name?: string;
    num_buses: number;
    num_branches: number;
    num_generators: number;
    num_loads: number;
    base_mva?: number;
    total_load_mw?: number;
    total_gen_capacity_mw?: number;
  };
  training_distribution_comparison: GridMetadataComparison;
}

// -----------------------------------------------------------------------------
// Phase 2: Dataset Card & Inspector Types
// -----------------------------------------------------------------------------
export interface DatasetCardResponse {
  dataset_name: string;
  description: string;
  version?: string;
  pipeline_hash?: string;
  generated_at?: string;
  scenario_counts: {
    total_simulated: number;
    safe_labels_count: number;
    cascade_labels_count: number;
    safe_labels_percentage: number;
    cascade_labels_percentage: number;
  };
  contingency_distribution: {
    'N-1_line': { count: number; percentage: number };
    'N-2_line': { count: number; percentage: number };
    'N-1_gen': { count: number; percentage: number };
  };
  load_range: {
    min_load_scale: number;
    max_load_scale: number;
    load_step: number;
    distribution_type: string;
  };
  label_definition: {
    cascade_rule: string;
    additional_trips_threshold: number;
    loss_of_load_threshold_pct: number;
  };
  simulator_settings: {
    simulator_engine: string;
    branch_thermal_limit_factor: number;
    island_detection: string;
    max_iterations_per_cascade: number;
    convergence_tolerance_mw: number;
  };
  split_sizes?: Record<string, Record<string, number>>;
  splits_and_leakage_audit: {
    headline_split?: string;
    split_sizes?: Record<string, Record<string, number>>;
    split_definitions?: Record<string, string>;
    class_balance_per_split?: Record<string, {
      train: SplitSubsetStats;
      val: SplitSubsetStats;
      test: SplitSubsetStats;
    }>;
    leakage_assertions?: Record<string, SplitLeakageAssertion>;
    zero_temporal_leakage_guarantee?: string;
    splits?: {
      train: { count: number; percentage: number; cascade_rate: number };
      val: { count: number; percentage: number; cascade_rate: number };
      test: { count: number; percentage: number; cascade_rate: number };
      held_out_contingencies: { count: number; percentage: number; cascade_rate: number };
    };
  };
  data_quality: {
    total_scenarios_attempted: number;
    ac_power_flow_converged_pct: number;
    non_converged_count: number;
    islanding_events_count: number;
    handling_of_non_converged_cases: string;
  };
  feature_dictionary?: FeatureInfo[];
}

export interface FeatureInfo {
  name: string;
  type: 'node' | 'edge';
  unit: string;
  description: string;
  first_post_contingency_only: boolean;
}

export interface FeatureDistributionResponse {
  feature: string;
  split: string;
  total_samples: number;
  bin_edges: number[];
  safe_counts: number[];
  cascade_counts: number[];
}

export interface DatasetSampleResponse {
  scenario_id: number;
  contingency_id: string;
  contingency_type: string;
  load_scale: number;
  cascade_label: number;
  bus_count: number;
  branch_count: number;
  num_buses?: number;
  num_branches?: number;
  bus_snapshot: Array<{
    bus_id: number;
    vm_pu: number;
    va_degree: number;
    p_mw: number;
    q_mvar: number;
  }>;
  branch_snapshot: Array<{
    branch_id: number;
    from_bus: number;
    to_bus: number;
    loading_percent: number;
    p_from_mw: number;
    q_from_mvar: number;
    in_service: boolean;
  }>;
  zero_leakage_note: string;
}

// -----------------------------------------------------------------------------
// Phase 2: Global Insights Types
// -----------------------------------------------------------------------------
export interface CalibrationBin {
  predicted_risk_center: number;
  actual_cascade_frequency: number;
  sample_count: number;
}

export interface GlobalInsightsResponse {
  calibration_curve: {
    bins: CalibrationBin[];
    brier_score: number;
    calibration_status: string;
  };
  most_frequently_important_branches: Array<{
    branch_id: number;
    name: string;
    importance_frequency_pct: number;
    mean_attribution_score: number;
  }>;
  top_feature_groups: Record<string, number>;
  error_gallery: {
    false_negatives: Array<{
      sample_id: number;
      grid: string;
      outaged: string[];
      load_scale: number;
      predicted_prob: number;
      actual_cascade: number;
      why: string;
    }>;
    false_positives: Array<{
      sample_id: number;
      grid: string;
      outaged: string[];
      load_scale: number;
      predicted_prob: number;
      actual_cascade: number;
      why: string;
    }>;
  };
}

// -----------------------------------------------------------------------------
// Phase 2: Mitigation Actions Types
// -----------------------------------------------------------------------------
export interface MitigationAction {
  id: string;
  title: string;
  description: string;
  action_type: string;
  status: 'model estimate' | 'simulator verified';
  predicted_risk: number;
  risk_reduction: number;
  predicted_alert_level: string;
  curtailment_scale?: number;
  restore_branch_id?: number;
  parameters?: Record<string, any>;
  simulator_verification?: {
    cascade_prevented: boolean;
    simulated_additional_trips: number;
    final_load_shed_fraction: number;
    verification_status: string;
  } | null;
}

export interface MitigateResponse {
  grid_id: string;
  outaged: string[];
  load_scale: number;
  initial_risk: number;
  actions: MitigationAction[];
  summary: string;
}

// -----------------------------------------------------------------------------
// Phase 2: Chat Assistant Types
// -----------------------------------------------------------------------------
export interface ChatUIAction {
  action: 'select_outage' | 'set_load' | 'show_criticality' | 'switch_tab';
  value?: any;
  description: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ name: string; args: any }>;
  toolResults?: Array<{ name: string; data: any }>;
  actions?: ChatUIAction[];
  mitigationActions?: MitigationAction[];
  timestamp: number;
  isStreaming?: boolean;
}
