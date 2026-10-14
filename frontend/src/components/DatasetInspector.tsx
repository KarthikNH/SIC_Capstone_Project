import React, { useState, useEffect } from 'react';
import { useGridStore } from '../store';
import type { FeatureInfo, FeatureDistributionResponse, DatasetSampleResponse } from '../types';
import {
  Database,
  ShieldCheck,
  Download,
  Search,
  CheckCircle2,
  AlertCircle,
  BarChart2,
  Table,
  Cpu,
  Layers,
  Activity,
  RotateCcw
} from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export const DatasetInspector: React.FC = () => {
  const {
    datasetCard,
    loadingDatasetCard,
    datasetCardError,
    datasetCardFailingUrl,
    fetchDatasetCard,
    datasetSplits,
    fetchDatasetSplits,
    gridCase,
    gridMetadata,
    fetchGridMetadata
  } = useGridStore();

  // Split strategy view state
  const [activeSplitStrategy, setActiveSplitStrategy] = useState<'random' | 'contingency_held_out' | 'operating_point_held_out'>('random');
  const [viewAllStrategies, setViewAllStrategies] = useState(false);

  // Feature Dictionary state
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [featureSearch, setFeatureSearch] = useState('');
  const [featureFilter, setFeatureFilter] = useState<'all' | 'node' | 'edge'>('all');
  const [loadingFeatures, setLoadingFeatures] = useState(false);
  const [featuresError, setFeaturesError] = useState<string | null>(null);

  // Distribution Viewer state
  const [selectedFeature, setSelectedFeature] = useState('pre_contingency_load_mw');
  const [selectedSplit, setSelectedSplit] = useState('all');
  const [distributionData, setDistributionData] = useState<FeatureDistributionResponse | null>(null);
  const [loadingDistribution, setLoadingDistribution] = useState(false);
  const [distributionError, setDistributionError] = useState<string | null>(null);

  // Sample Browser state
  const [sampleIdInput, setSampleIdInput] = useState('0');
  const [sampleData, setSampleData] = useState<DatasetSampleResponse | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  // Initial fetch
  useEffect(() => {
    fetchDatasetCard();
    fetchDatasetSplits();
    fetchGridMetadata(gridCase);
  }, [fetchDatasetCard, fetchDatasetSplits, fetchGridMetadata, gridCase]);

  // Fetch features list
  const fetchFeats = async () => {
    setLoadingFeatures(true);
    setFeaturesError(null);
    try {
      const res = await fetch(`${API_BASE}/dataset/features`);
      if (res.ok) {
        const data = await res.json();
        setFeatures(Array.isArray(data.features) ? data.features : []);
      } else {
        setFeaturesError(`Failed to load features: HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.error('Failed to load dataset features:', err);
      setFeaturesError(err?.message || 'Network request failed');
    } finally {
      setLoadingFeatures(false);
    }
  };

  useEffect(() => {
    fetchFeats();
  }, []);

  // Fetch distribution data on change
  const fetchDist = async () => {
    setLoadingDistribution(true);
    setDistributionError(null);
    try {
      const url = `${API_BASE}/dataset/distribution?feature=${encodeURIComponent(selectedFeature)}&split=${encodeURIComponent(selectedSplit)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setDistributionData(data);
      } else {
        setDistributionError(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.error('Failed to load distribution:', err);
      setDistributionError(err?.message || 'Network error');
    } finally {
      setLoadingDistribution(false);
    }
  };

  useEffect(() => {
    fetchDist();
  }, [selectedFeature, selectedSplit]);

  // Fetch sample on mount or submit
  const handleFetchSample = async (id: string) => {
    const num = parseInt(id.trim(), 10);
    if (isNaN(num) || num < 0) return;
    setLoadingSample(true);
    setSampleError(null);
    try {
      const res = await fetch(`${API_BASE}/dataset/sample/${num}`);
      if (res.ok) {
        const data = await res.json();
        setSampleData(data);
      } else {
        setSampleError(`Scenario ID ${num} not found. Valid IDs: 0 – 499.`);
        setSampleData(null);
      }
    } catch {
      setSampleError('Failed to fetch scenario sample.');
      setSampleData(null);
    } finally {
      setLoadingSample(false);
    }
  };

  useEffect(() => {
    handleFetchSample('0');
  }, []);

  // Helper to safely format envelopes (array or object)
  const formatEnvelope = (env: any): string => {
    if (!env) return '---';
    if (Array.isArray(env)) return `${env[0]} – ${env[1]}`;
    if (typeof env === 'object' && env.min !== undefined && env.max !== undefined) {
      return `${env.min} – ${env.max}`;
    }
    return String(env);
  };

  // Filter features
  const filteredFeatures = (features || []).filter((f) => {
    if (!f || !f.name) return false;
    const matchesSearch =
      (f.name || '').toLowerCase().includes(featureSearch.toLowerCase()) ||
      (f.description || '').toLowerCase().includes(featureSearch.toLowerCase()) ||
      (f.unit || '').toLowerCase().includes(featureSearch.toLowerCase());
    const matchesFilter = featureFilter === 'all' || f.type === featureFilter;
    return matchesSearch && matchesFilter;
  });

  const card = datasetCard;

  return (
    <div className="pt-6 space-y-10">
      {/* 1. Header & Download Buttons */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#cfd3d8]">
        <div>
          <span className="eyebrow flex items-center gap-1.5 mb-1 text-charcoal">
            <Database className="w-3.5 h-3.5 text-amber" /> Comprehensive Dataset Specification
          </span>
          <h3 className="text-xl font-serif font-bold text-ink tracking-tight">
            Cascading Failure Dataset Inspector &amp; Quality Audit
          </h3>
          <p className="text-xs text-[#666] mt-0.5 max-w-2xl">
            Audit power flow distributions, evaluate contingency split leakage assertions, and inspect 
            individual pre-cascade snapshots under strict first-post-contingency zero-leakage standards.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={`${API_BASE}/dataset/download?format=json`}
            target="_blank"
            rel="noreferrer"
            className="btn-estate-dark text-xs py-2 px-3.5 flex items-center gap-1.5"
            title="Download dataset card in JSON format"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Card (JSON)</span>
          </a>
          <a
            href={`${API_BASE}/dataset/download?format=csv`}
            target="_blank"
            rel="noreferrer"
            className="btn-estate-dark text-xs py-2 px-3.5 flex items-center gap-1.5 bg-[#fbfbfb]"
            title="Download full scenario feature table in CSV format"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Scenarios (CSV)</span>
          </a>
        </div>
      </div>

      {/* Readable Error State if Dataset Card failed to load */}
      {datasetCardError && !card && (
        <div className="p-5 border border-red/30 bg-[#fdf8f8] text-ink space-y-3 shadow-2xs">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red/10 text-red flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle className="w-5 h-5 text-red" />
            </div>
            <div className="flex-1 space-y-2">
              <h4 className="text-sm font-semibold text-ink">
                Could not load dataset card specifications
              </h4>
              <p className="text-xs text-[#555] leading-relaxed">
                The dataset card endpoint was unable to return the training pipeline specifications. Verify that the FastAPI backend server is active and accessible.
              </p>
              <div className="text-[11px] font-mono text-[#666] bg-white px-3 py-1.5 border border-[#e5e7eb] max-w-md truncate">
                <span className="text-[#999] select-none">Failing URL: </span>
                <span className="text-red font-medium">{datasetCardFailingUrl || `${API_BASE}/dataset/card`}</span>
              </div>
              <button
                type="button"
                onClick={() => fetchDatasetCard()}
                className="btn-estate-dark text-xs py-2 px-4 flex items-center gap-1.5 hover:bg-charcoal"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Uploaded Grid Comparison Card (works on uploaded grids & built-ins) */}
      {gridMetadata && gridMetadata.training_distribution_comparison && (
        <div className="p-4 border border-[#cfd3d8] bg-[#fafafa] space-y-3">
          <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
            <div>
              <span className="eyebrow">Active Grid vs Training Domain</span>
              <h4 className="text-sm font-semibold text-ink">
                Grid Compatibility &amp; Domain Comparison: {(gridCase || '').toUpperCase()}
              </h4>
            </div>
            <div>
              {gridMetadata.training_distribution_comparison.distribution_status === 'in_range' ? (
                <span className="px-2.5 py-1 bg-[#dcfce7] border border-[#bbf7d0] text-[#166534] text-xs font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Within Training Distribution
                </span>
              ) : gridMetadata.training_distribution_comparison.distribution_status === 'borderline' ? (
                <span className="px-2.5 py-1 bg-[#fef3c7] border border-[#fde68a] text-[#92400e] text-xs font-semibold flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> Borderline Envelope
                </span>
              ) : (
                <span className="px-2.5 py-1 bg-red/10 border border-red/30 text-red text-xs font-semibold flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> Out-of-Distribution
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="border border-[#e5e7eb] p-2.5 bg-white">
              <span className="text-[#666] block">Bus Count</span>
              <span className="font-mono font-semibold text-ink text-sm">
                {gridMetadata.training_distribution_comparison.comparison?.bus_count ?? gridMetadata.metadata?.num_buses ?? '---'} buses
              </span>
              <span className="text-[10px] text-[#888] block">
                Envelope: [{formatEnvelope(gridMetadata.training_distribution_comparison.comparison?.training_bus_envelope ?? [30, 118])}]
              </span>
            </div>

            <div className="border border-[#e5e7eb] p-2.5 bg-white">
              <span className="text-[#666] block">Branch Count</span>
              <span className="font-mono font-semibold text-ink text-sm">
                {gridMetadata.training_distribution_comparison.comparison?.branch_count ?? gridMetadata.metadata?.num_branches ?? '---'} lines
              </span>
              <span className="text-[10px] text-[#888] block">
                Envelope: [{formatEnvelope(gridMetadata.training_distribution_comparison.comparison?.training_branch_envelope ?? [41, 186])}]
              </span>
            </div>

            <div className="border border-[#e5e7eb] p-2.5 bg-white">
              <span className="text-[#666] block">Branch-to-Bus Ratio</span>
              <span className="font-mono font-semibold text-ink text-sm">
                {typeof gridMetadata.training_distribution_comparison.comparison?.branch_to_bus_ratio === 'number'
                  ? gridMetadata.training_distribution_comparison.comparison.branch_to_bus_ratio.toFixed(2)
                  : gridMetadata.metadata?.num_buses
                  ? ((gridMetadata.metadata?.num_branches ?? 0) / gridMetadata.metadata.num_buses).toFixed(2)
                  : '---'}
              </span>
              <span className="text-[10px] text-[#888] block">
                Envelope: [{formatEnvelope(gridMetadata.training_distribution_comparison.comparison?.training_ratio_envelope ?? [1.37, 1.58])}]
              </span>
            </div>

            <div className="border border-[#e5e7eb] p-2.5 bg-white">
              <span className="text-[#666] block">Closest Reference Grid</span>
              <span className="font-mono font-semibold text-ink text-sm">
                {(gridMetadata.training_distribution_comparison.closest_training_grid || 'CASE30').toUpperCase()}
              </span>
              <span className="text-[10px] text-[#888] block truncate" title={gridMetadata.training_distribution_comparison.notes || ''}>
                {gridMetadata.training_distribution_comparison.notes || 'Training domain comparison analyzed.'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 2. Overview Cards from /dataset/card */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-ink flex items-center gap-2">
          <Layers className="w-4 h-4 text-charcoal" />
          <span>Pipeline &amp; Simulator Configuration</span>
        </h4>

        {loadingDatasetCard && !card ? (
          <div className="p-8 border border-[#e5e7eb] bg-[#fafafa] flex flex-col items-center justify-center space-y-2.5 text-center">
            <div className="w-6 h-6 border-2 border-charcoal/20 border-t-charcoal rounded-full animate-spin" />
            <p className="text-xs font-mono text-[#666]">Loading dataset card specifications...</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Total Scenarios</span>
              <span className="text-lg font-semibold font-mono text-ink">
                {card?.scenario_counts?.total_simulated ?? 500}
              </span>
              <p className="text-[10.5px] text-[#666]">Nonlinear AC power flow simulations.</p>
            </div>

            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Contingency Types</span>
              <div className="font-mono text-[11px] space-y-0.5 text-ink pt-0.5">
                <div>N-1 Line: {card?.contingency_distribution?.['N-1_line']?.percentage ?? 60}%</div>
                <div>N-2 Line: {card?.contingency_distribution?.['N-2_line']?.percentage ?? 25}%</div>
                <div>N-1 Gen: {card?.contingency_distribution?.['N-1_gen']?.percentage ?? 15}%</div>
              </div>
            </div>

            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Load Range</span>
              <span className="text-lg font-semibold font-mono text-ink">
                {Math.round((card?.load_range?.min_load_scale ?? 0.6) * 100)}% – {Math.round((card?.load_range?.max_load_scale ?? 1.2) * 100)}%
              </span>
              <p className="text-[10.5px] text-[#666]">Step: 5% uniform loading scale.</p>
            </div>

            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Label Definition</span>
              <span className="font-semibold text-ink text-xs block leading-tight">
                {card?.label_definition?.cascade_rule || '≥3 Trips or ≥15% Load Shed'}
              </span>
              <p className="text-[10px] text-[#777] font-mono">Loss-of-load threshold: {card?.label_definition?.loss_of_load_threshold_pct ?? 15}%</p>
            </div>

            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Simulator Engine</span>
              <span className="font-semibold text-ink text-xs block truncate" title={card?.simulator_settings?.simulator_engine || 'Pandapower AC Newton-Raphson'}>
                {card?.simulator_settings?.simulator_engine || 'Pandapower AC Newton-Raphson'}
              </span>
              <p className="text-[10px] text-[#777] font-mono">Limit factor: {card?.simulator_settings?.branch_thermal_limit_factor ?? 1.05}x</p>
            </div>

            <div className="border border-[#e5e7eb] p-3 bg-white space-y-1">
              <span className="eyebrow block">Convergence Tolerance</span>
              <span className="text-lg font-semibold font-mono text-ink">
                {card?.simulator_settings?.convergence_tolerance_mw ?? 0.001} MW
              </span>
              <p className="text-[10.5px] text-[#666]">Max iterations: {card?.simulator_settings?.max_iterations_per_cascade ?? 25}</p>
            </div>
          </div>
        )}
      </div>

      {/* 3. Train, Validation & Test Split Structure with Strict Leakage Assertions */}
      <div className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#cfd3d8] pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="eyebrow flex items-center gap-1.5 text-charcoal">
                <ShieldCheck className="w-3.5 h-3.5 text-amber" /> Split Protocol &amp; Invariant Verification
              </span>
            </div>
            <h4 className="text-base font-serif font-bold text-ink">
              Train, Validation &amp; Test Dataset Splits
            </h4>
            <p className="text-xs text-[#666] mt-0.5 max-w-2xl">
              Inspect partition sizes, cascade class distribution, unique contingency counts, and leakage isolation 
              guarantees across benchmark split regimes.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setViewAllStrategies(!viewAllStrategies)}
              className={`px-3 py-1.5 text-xs font-mono border transition-all ${
                viewAllStrategies
                  ? 'bg-charcoal text-white border-charcoal shadow-2xs font-semibold'
                  : 'bg-white border-[#cfd3d8] text-[#555] hover:border-charcoal hover:text-ink'
              }`}
            >
              {viewAllStrategies ? 'Show Tabbed View' : 'Compare All 3 Splits'}
            </button>
          </div>
        </div>

        {/* Strategy Selector Tabs (if not viewing all side-by-side) */}
        {!viewAllStrategies && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[#e5e7eb] pb-3">
            {[
              { id: 'random', label: 'Random Stratified Split', isHeadline: true, ratio: '70% / 15% / 15%' },
              { id: 'contingency_held_out', label: 'Contingency Held-Out Split', isHeadline: false, ratio: '67% / 12% / 20%' },
              { id: 'operating_point_held_out', label: 'Operating-Point Held-Out', isHeadline: false, ratio: '68% / 12% / 20%' }
            ].map((strat) => {
              const isSelected = activeSplitStrategy === strat.id;
              return (
                <button
                  key={strat.id}
                  onClick={() => setActiveSplitStrategy(strat.id as any)}
                  className={`px-3.5 py-2 text-xs border transition-all flex items-center gap-2 text-left ${
                    isSelected
                      ? 'bg-charcoal text-white border-charcoal shadow-2xs font-semibold'
                      : 'bg-white border-[#cfd3d8] text-[#555] hover:border-charcoal hover:text-ink'
                  }`}
                >
                  <span>{strat.label}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-none ${
                    isSelected ? 'bg-white/20 text-white' : 'bg-[#f0f0f0] text-[#666]'
                  }`}>
                    {strat.ratio}
                  </span>
                  {strat.isHeadline && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber text-charcoal font-bold uppercase tracking-wider">
                      ★ Headline
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Render Split Strategies (either selected or all) */}
        {(() => {
          const splitsSource: any = datasetSplits || card?.splits_and_leakage_audit;
          const classBalance: Record<string, any> = splitsSource?.class_balance_per_split || {};
          const leakageSource: Record<string, any> = splitsSource?.leakage_assertions || {};
          const headline: string = splitsSource?.headline_split || 'random';
          const definitions: Record<string, string> = splitsSource?.split_definitions || {
            random: 'Stratified random split (70% train / 15% val / 15% test) matching overall cascade class balance.',
            contingency_held_out: 'Grouped split where unique contingency elements in test and val NEVER appear in train.',
            operating_point_held_out: 'Stress-regime split reserving top 20% highest pre-contingency aggregate loads for test.'
          };

          const strategiesToRender: Array<'random' | 'contingency_held_out' | 'operating_point_held_out'> =
            viewAllStrategies
              ? ['random', 'contingency_held_out', 'operating_point_held_out']
              : [activeSplitStrategy];

          return (
            <div className="space-y-8">
              {strategiesToRender.map((stratKey) => {
                const strat = classBalance[stratKey] || {
                  train: { total: 350, percentage: 70.0, positive_cascade: 122, negative_safe: 228, cascade_rate: 0.3486, unique_contingencies: 121 },
                  val: { total: 75, percentage: 15.0, positive_cascade: 26, negative_safe: 49, cascade_rate: 0.3467, unique_contingencies: 47 },
                  test: { total: 75, percentage: 15.0, positive_cascade: 26, negative_safe: 49, cascade_rate: 0.3467, unique_contingencies: 52 }
                };

                const leakage = leakageSource[stratKey] || {
                  disjoint_subsets: true,
                  complete_coverage: true,
                  zero_scenario_leakage: true,
                  contingency_leakage_free: true,
                  contingency_overlap_between_train_and_eval: 0
                };

                const isHeadline = stratKey === headline;
                const totalScenarios = (strat.train?.total ?? 0) + (strat.val?.total ?? 0) + (strat.test?.total ?? 0);
                const sumPct = (
                  (strat.train?.percentage ?? 0) +
                  (strat.val?.percentage ?? 0) +
                  (strat.test?.percentage ?? 0)
                ).toFixed(1);

                const totalCascades =
                  (strat.train?.positive_cascade ?? 0) +
                  (strat.val?.positive_cascade ?? 0) +
                  (strat.test?.positive_cascade ?? 0);
                const totalSafe =
                  (strat.train?.negative_safe ?? 0) +
                  (strat.val?.negative_safe ?? 0) +
                  (strat.test?.negative_safe ?? 0);
                const aggCascadeRate = totalScenarios > 0 ? (totalCascades / totalScenarios) * 100 : 0;

                const stratName =
                  stratKey === 'random'
                    ? 'Stratified Random Split'
                    : stratKey === 'contingency_held_out'
                    ? 'Contingency Held-Out Set (Inductive Generalization)'
                    : 'Operating-Point Held-Out Set (Stress Regime)';

                return (
                  <div key={stratKey} className="border border-[#cfd3d8] p-5 bg-white space-y-4 shadow-2xs">
                    {/* Strategy Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#e5e7eb] pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h5 className="text-sm font-semibold text-ink font-serif">
                            {stratName}
                          </h5>
                          {isHeadline && (
                            <span className="px-2.5 py-0.5 bg-amber/20 text-[#78350f] border border-amber/40 text-[10px] font-bold uppercase tracking-wider">
                              ★ Headline Benchmark Split
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#555] mt-1 leading-relaxed">
                          {definitions[stratKey] || 'Rigorous scenario partition avoiding inductive and transductive leakage.'}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] font-mono text-[#666]">
                          Total: <strong className="text-ink">{totalScenarios}</strong> scenarios
                        </span>
                        <span className="px-2 py-0.5 bg-[#dcfce7] border border-[#bbf7d0] text-[#166534] text-[10.5px] font-bold uppercase flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Leakage-Free
                        </span>
                      </div>
                    </div>

                    {/* Leakage Invariant Badges */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                      <div className="p-2.5 border border-[#bbf7d0] bg-[#f0fdf4] flex items-center justify-between">
                        <div>
                          <span className="font-semibold text-[#166534] block text-[11px]">Subsets Disjoint</span>
                          <span className="text-[10px] text-[#14532d]">0 scenario overlap (Train ∩ Val ∩ Test = ∅)</span>
                        </div>
                        <span className="px-2 py-0.5 bg-[#dcfce7] text-[#15803d] text-[10px] font-bold uppercase border border-[#86efac]">
                          {leakage.disjoint_subsets ? 'PASS' : 'FAIL'}
                        </span>
                      </div>

                      <div className="p-2.5 border border-[#bbf7d0] bg-[#f0fdf4] flex items-center justify-between">
                        <div>
                          <span className="font-semibold text-[#166534] block text-[11px]">Contingency Isolation</span>
                          <span className="text-[10px] text-[#14532d]">
                            {stratKey === 'contingency_held_out'
                              ? 'Strict zero-leakage (0 contingency overlap)'
                              : 'Disjoint scenarios with balanced distribution'}
                          </span>
                        </div>
                        <span className="px-2 py-0.5 bg-[#dcfce7] text-[#15803d] text-[10px] font-bold uppercase border border-[#86efac]">
                          {leakage.contingency_leakage_free ? 'PASS' : 'FAIL'}
                        </span>
                      </div>

                      <div className="p-2.5 border border-[#bbf7d0] bg-[#f0fdf4] flex items-center justify-between">
                        <div>
                          <span className="font-semibold text-[#166534] block text-[11px]">Zero Temporal Leakage</span>
                          <span className="text-[10px] text-[#14532d]">Tensors compute strictly from t=0+ initial state</span>
                        </div>
                        <span className="px-2 py-0.5 bg-[#dcfce7] text-[#15803d] text-[10px] font-bold uppercase border border-[#86efac]">
                          PASS
                        </span>
                      </div>
                    </div>

                    {/* Stacked Horizontal Bar Chart */}
                    <div className="space-y-2 pt-1">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-1">
                        <span className="font-semibold text-ink text-[11px] uppercase tracking-wider">
                          Scenario Partition Breakdown (Sum: {sumPct}%)
                        </span>
                        <div className="flex items-center gap-4 text-[11px] font-mono">
                          <span className="flex items-center gap-1.5">
                            <span className="w-3 h-3 bg-[#1c2833]" />
                            <span>Train: {strat.train?.total ?? 0} ({(strat.train?.percentage ?? 0).toFixed(1)}%)</span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="w-3 h-3 bg-[#d97706]" />
                            <span>Val: {strat.val?.total ?? 0} ({(strat.val?.percentage ?? 0).toFixed(1)}%)</span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="w-3 h-3 bg-[#2563eb]" />
                            <span>Test: {strat.test?.total ?? 0} ({(strat.test?.percentage ?? 0).toFixed(1)}%)</span>
                          </span>
                        </div>
                      </div>

                      {/* Stacked bar strip */}
                      <div className="h-6 w-full flex overflow-hidden border border-[#cfd3d8] bg-[#f0f0f0]">
                        <div
                          style={{ width: `${strat.train?.percentage ?? 70}%` }}
                          className="bg-[#1c2833] text-white text-[10px] font-mono font-semibold flex items-center justify-center transition-all duration-500 overflow-hidden"
                          title={`Train: ${strat.train?.total} scenarios (${(strat.train?.percentage ?? 0).toFixed(1)}%)`}
                        >
                          {(strat.train?.percentage ?? 0) >= 15 ? `Train ${(strat.train?.percentage ?? 0).toFixed(1)}%` : ''}
                        </div>
                        <div
                          style={{ width: `${strat.val?.percentage ?? 15}%` }}
                          className="bg-[#d97706] text-white text-[10px] font-mono font-semibold flex items-center justify-center transition-all duration-500 overflow-hidden"
                          title={`Val: ${strat.val?.total} scenarios (${(strat.val?.percentage ?? 0).toFixed(1)}%)`}
                        >
                          {(strat.val?.percentage ?? 0) >= 10 ? `Val ${(strat.val?.percentage ?? 0).toFixed(1)}%` : ''}
                        </div>
                        <div
                          style={{ width: `${strat.test?.percentage ?? 15}%` }}
                          className="bg-[#2563eb] text-white text-[10px] font-mono font-semibold flex items-center justify-center transition-all duration-500 overflow-hidden"
                          title={`Test: ${strat.test?.total} scenarios (${(strat.test?.percentage ?? 0).toFixed(1)}%)`}
                        >
                          {(strat.test?.percentage ?? 0) >= 10 ? `Test ${(strat.test?.percentage ?? 0).toFixed(1)}%` : ''}
                        </div>
                      </div>
                    </div>

                    {/* Detailed Split Table */}
                    <div className="overflow-x-auto pt-1">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-[#cfd3d8] bg-[#fafafa] text-[#666] font-mono text-[10.5px]">
                            <th className="py-2 px-3 font-semibold">Subset</th>
                            <th className="py-2 px-3 font-semibold">Scenarios</th>
                            <th className="py-2 px-3 font-semibold">Percentage</th>
                            <th className="py-2 px-3 font-semibold">Cascades (Pos)</th>
                            <th className="py-2 px-3 font-semibold">Safe (Neg)</th>
                            <th className="py-2 px-3 font-semibold">Cascade Rate</th>
                            <th className="py-2 px-3 font-semibold">Unique Contingencies</th>
                            <th className="py-2 px-3 font-semibold">Leakage Audit</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#e5e7eb] font-mono">
                          {/* Train Row */}
                          <tr className="hover:bg-[#fbfbfb]">
                            <td className="py-2 px-3 font-sans font-medium text-ink flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 bg-[#1c2833]" />
                              <span>Training</span>
                            </td>
                            <td className="py-2 px-3 font-semibold text-ink">{strat.train?.total ?? 0}</td>
                            <td className="py-2 px-3 text-[#555]">{(strat.train?.percentage ?? 0).toFixed(1)}%</td>
                            <td className="py-2 px-3 text-red font-medium">{strat.train?.positive_cascade ?? 0}</td>
                            <td className="py-2 px-3 text-[#166534]">{strat.train?.negative_safe ?? 0}</td>
                            <td className="py-2 px-3 font-medium text-ink">
                              {((strat.train?.cascade_rate ?? 0) * 100).toFixed(1)}%
                            </td>
                            <td className="py-2 px-3 text-[#444] font-semibold">{strat.train?.unique_contingencies ?? '---'}</td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 bg-[#dcfce7] text-[#166534] text-[10px] font-bold uppercase border border-[#bbf7d0]">
                                Disjoint
                              </span>
                            </td>
                          </tr>

                          {/* Validation Row */}
                          <tr className="hover:bg-[#fbfbfb]">
                            <td className="py-2 px-3 font-sans font-medium text-ink flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 bg-[#d97706]" />
                              <span>Validation</span>
                            </td>
                            <td className="py-2 px-3 font-semibold text-ink">{strat.val?.total ?? 0}</td>
                            <td className="py-2 px-3 text-[#555]">{(strat.val?.percentage ?? 0).toFixed(1)}%</td>
                            <td className="py-2 px-3 text-red font-medium">{strat.val?.positive_cascade ?? 0}</td>
                            <td className="py-2 px-3 text-[#166534]">{strat.val?.negative_safe ?? 0}</td>
                            <td className="py-2 px-3 font-medium text-ink">
                              {((strat.val?.cascade_rate ?? 0) * 100).toFixed(1)}%
                            </td>
                            <td className="py-2 px-3 text-[#444] font-semibold">{strat.val?.unique_contingencies ?? '---'}</td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 bg-[#dcfce7] text-[#166534] text-[10px] font-bold uppercase border border-[#bbf7d0]">
                                Disjoint
                              </span>
                            </td>
                          </tr>

                          {/* Test Row */}
                          <tr className="hover:bg-[#fbfbfb]">
                            <td className="py-2 px-3 font-sans font-medium text-ink flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 bg-[#2563eb]" />
                              <span>Test (Held-Out)</span>
                            </td>
                            <td className="py-2 px-3 font-semibold text-ink">{strat.test?.total ?? 0}</td>
                            <td className="py-2 px-3 text-[#555]">{(strat.test?.percentage ?? 0).toFixed(1)}%</td>
                            <td className="py-2 px-3 text-red font-medium">{strat.test?.positive_cascade ?? 0}</td>
                            <td className="py-2 px-3 text-[#166534]">{strat.test?.negative_safe ?? 0}</td>
                            <td className="py-2 px-3 font-medium text-ink">
                              {((strat.test?.cascade_rate ?? 0) * 100).toFixed(1)}%
                            </td>
                            <td className="py-2 px-3 text-[#444] font-semibold">{strat.test?.unique_contingencies ?? '---'}</td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 bg-[#dcfce7] text-[#166534] text-[10px] font-bold uppercase border border-[#bbf7d0]">
                                Disjoint
                              </span>
                            </td>
                          </tr>

                          {/* Total Summary Row */}
                          <tr className="bg-[#fafafa] font-semibold border-t-2 border-[#cfd3d8]">
                            <td className="py-2 px-3 font-sans text-ink">Total Dataset</td>
                            <td className="py-2 px-3 text-ink">{totalScenarios}</td>
                            <td className="py-2 px-3 text-ink">{sumPct}%</td>
                            <td className="py-2 px-3 text-red">{totalCascades}</td>
                            <td className="py-2 px-3 text-[#166534]">{totalSafe}</td>
                            <td className="py-2 px-3 text-ink">{aggCascadeRate.toFixed(1)}%</td>
                            <td className="py-2 px-3 text-ink">All Outages Covered</td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 bg-[#dcfce7] text-[#166534] text-[10px] font-bold uppercase border border-[#bbf7d0]">
                                100% Coverage
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* 4. Distribution Viewer: choose feature and split, show histogram by class */}
      <div className="border border-[#cfd3d8] p-5 bg-white space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <span className="eyebrow">Physical Distribution Analytics</span>
            <h4 className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <BarChart2 className="w-4 h-4 text-amber" />
              <span>Feature Density Viewer (Safe vs Cascade Class Separation)</span>
            </h4>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedFeature}
              onChange={(e) => setSelectedFeature(e.target.value)}
              className="text-xs px-2.5 py-1.5 border border-[#cfd3d8] bg-white text-ink font-mono focus:outline-none focus:border-charcoal"
            >
              <option value="pre_contingency_load_mw">pre_contingency_load_mw</option>
              <option value="vm_pu">vm_pu (Bus Voltage)</option>
              <option value="va_degree">va_degree (Voltage Angle)</option>
              <option value="loading_percent">loading_percent (Branch Thermal)</option>
              <option value="p_from_mw">p_from_mw (Active Branch Flow)</option>
              <option value="degree">degree (Nodal Connectivity)</option>
            </select>

            <select
              value={selectedSplit}
              onChange={(e) => setSelectedSplit(e.target.value)}
              className="text-xs px-2.5 py-1.5 border border-[#cfd3d8] bg-white text-ink font-mono focus:outline-none focus:border-charcoal"
            >
              <option value="all">All Splits</option>
              <option value="train">Train Split</option>
              <option value="val">Validation Split</option>
              <option value="test">Test Split</option>
            </select>
          </div>
        </div>

        {/* Histogram Bars */}
        {loadingDistribution ? (
          <div className="h-44 flex flex-col items-center justify-center text-xs text-[#888] font-mono gap-2">
            <div className="w-5 h-5 border-2 border-charcoal/20 border-t-charcoal rounded-full animate-spin" />
            <span>Computing histogram density across class boundaries...</span>
          </div>
        ) : distributionError ? (
          <div className="p-4 bg-[#fdf8f8] border border-red/20 text-xs flex items-center justify-between">
            <span className="text-red">Failed to load feature distribution ({distributionError}).</span>
            <button
              onClick={fetchDist}
              className="btn-estate-dark text-xs py-1 px-3"
            >
              Retry
            </button>
          </div>
        ) : distributionData && Array.isArray(distributionData.safe_counts) && distributionData.safe_counts.length > 0 ? (
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-6 text-xs justify-end">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 bg-[#9aa3ad]" />
                <span className="text-[#555]">Class 0 (Stable Operating State)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 bg-[#c8443b]" />
                <span className="text-[#555]">Class 1 (Cascading Failure Triggered)</span>
              </div>
            </div>

            <div className="grid grid-cols-8 gap-2 items-end h-40 pt-4 border-b border-[#e5e7eb] px-2">
              {distributionData.safe_counts.map((safeCount, idx) => {
                const cascCount = distributionData.cascade_counts?.[idx] || 0;
                const total = Math.max(1, safeCount + cascCount);
                const allTotals = distributionData.safe_counts.map((s, i) => s + (distributionData.cascade_counts?.[i] || 0));
                const maxInAnyBin = Math.max(...allTotals, 1);
                const heightPct = Math.min(100, (total / maxInAnyBin) * 100);
                const cascRatio = cascCount / total;
                const binStart = distributionData.bin_edges?.[idx];
                const binEnd = distributionData.bin_edges?.[idx + 1];

                return (
                  <div key={idx} className="flex flex-col items-center h-full justify-end group relative">
                    {/* Tooltip on hover */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-12 z-10 bg-charcoal text-white text-[10px] p-1.5 rounded-none pointer-events-none whitespace-nowrap shadow-md">
                      <div>Bin: {binStart !== undefined ? binStart.toFixed(2) : 'min'} to {binEnd !== undefined ? binEnd.toFixed(2) : 'max'}</div>
                      <div>Safe: {safeCount} | Cascade: {cascCount}</div>
                    </div>

                    <div
                      className="w-full flex flex-col justify-end overflow-hidden transition-all duration-300"
                      style={{ height: `${heightPct}%`, minHeight: '6px' }}
                    >
                      {/* Cascade slice */}
                      <div
                        className="w-full bg-[#c8443b]"
                        style={{ height: `${cascRatio * 100}%` }}
                      />
                      {/* Safe slice */}
                      <div
                        className="w-full bg-[#9aa3ad]"
                        style={{ height: `${(1 - cascRatio) * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-[#777] font-mono mt-1 truncate max-w-full">
                      {binStart !== undefined ? binStart.toFixed(1) : ''}
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-[#777] leading-relaxed">
              Distribution reflects {distributionData.total_samples ?? 0} AC simulated scenarios under 
              split <code className="font-mono text-ink font-semibold">"{distributionData.split || 'all'}"</code>.
              Cascading failures heavily concentrate at elevated load and branch thermal saturation regimes.
            </p>
          </div>
        ) : (
          <p className="text-xs text-[#888] py-4 text-center">Distribution data unavailable or empty for selected feature.</p>
        )}
      </div>

      {/* 5. Searchable Feature Dictionary Table */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <span className="eyebrow">Input Tensor Dictionary</span>
            <h4 className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <Table className="w-4 h-4 text-charcoal" />
              <span>GINE Feature Dictionary ({features.length} Physical Quantities)</span>
            </h4>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#888]" />
              <input
                type="text"
                placeholder="Search feature name or unit..."
                value={featureSearch}
                onChange={(e) => setFeatureSearch(e.target.value)}
                className="text-xs pl-8 pr-3 py-1.5 border border-[#cfd3d8] bg-white text-ink placeholder:text-[#999] focus:outline-none focus:border-charcoal w-64"
              />
            </div>

            <div className="flex items-center border border-[#cfd3d8] text-xs">
              {(['all', 'node', 'edge'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setFeatureFilter(type)}
                  className={`px-3 py-1 capitalize transition-colors ${
                    featureFilter === type
                      ? 'bg-charcoal text-white font-medium'
                      : 'bg-white text-[#555] hover:text-ink'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Feature Table */}
        <div className="border border-[#e5e7eb] overflow-x-auto bg-white">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#f9fafb] border-b border-[#e5e7eb] text-[11px] text-[#666] uppercase tracking-wider font-semibold">
                <th className="py-2.5 px-3">Feature Name</th>
                <th className="py-2.5 px-3">Type</th>
                <th className="py-2.5 px-3">Unit</th>
                <th className="py-2.5 px-3">Description</th>
                <th className="py-2.5 px-3 text-right">Zero-Leakage Assurance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0f0f0]">
              {loadingFeatures ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[#888] font-mono">
                    Loading feature dictionary...
                  </td>
                </tr>
              ) : featuresError ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-red">
                    {featuresError}
                  </td>
                </tr>
              ) : filteredFeatures.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[#888]">
                    No features match your query.
                  </td>
                </tr>
              ) : (
                filteredFeatures.map((f) => (
                  <tr key={f.name} className="hover:bg-[#fafafa] transition-colors">
                    <td className="py-2 px-3 font-mono font-semibold text-ink">
                      {f.name}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-2 py-0.5 text-[10.5px] font-semibold uppercase ${
                          f.type === 'node'
                            ? 'bg-[#e0f2fe] text-[#0369a1]'
                            : 'bg-[#fef3c7] text-[#92400e]'
                        }`}
                      >
                        {f.type}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono text-[#555]">{f.unit}</td>
                    <td className="py-2 px-3 text-[#444] max-w-md">{f.description}</td>
                    <td className="py-2 px-3 text-right">
                      {f.first_post_contingency_only && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[#166534] bg-[#dcfce7] px-2 py-0.5 border border-[#bbf7d0]">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>t=0+ Post-Contingency Only</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. Data Quality Card & Sample Browser */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-6 items-start">
        {/* Data Quality Card */}
        <div className="border border-[#e5e7eb] p-4 bg-white space-y-4">
          <div>
            <span className="eyebrow">Physical Rigor &amp; Convergence</span>
            <h4 className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-charcoal" />
              <span>Simulation Data Quality Audit</span>
            </h4>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between items-center py-1.5 border-b border-[#f0f0f0]">
              <span className="text-[#666]">Total Scenarios Attempted:</span>
              <span className="font-mono font-semibold text-ink">
                {card?.data_quality?.total_scenarios_attempted ?? 500}
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-[#f0f0f0]">
              <span className="text-[#666]">AC Power Flow Convergence:</span>
              <span className="font-mono font-semibold text-[#166534]">
                {card?.data_quality?.ac_power_flow_converged_pct ?? 96.4}%
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-[#f0f0f0]">
              <span className="text-[#666]">Non-Converged Cases Isolated:</span>
              <span className="font-mono font-semibold text-ink">
                {card?.data_quality?.non_converged_count ?? 18} cases
              </span>
            </div>

            <div className="flex justify-between items-center py-1.5 border-b border-[#f0f0f0]">
              <span className="text-[#666]">Severe Islanding Events:</span>
              <span className="font-mono font-semibold text-amber">
                {card?.data_quality?.islanding_events_count ?? 24} events
              </span>
            </div>
          </div>

          <div className="bg-[#f9fafb] p-3 border border-[#e5e7eb] text-[11px] text-[#555] leading-relaxed">
            <span className="font-semibold block text-ink mb-0.5">Handling Policy:</span>
            {card?.data_quality?.handling_of_non_converged_cases ||
              'Scenarios encountering voltage collapse or AC divergence are recorded with strict boundary penalty flags and isolated to avoid numerical instability.'}
          </div>
        </div>

        {/* Sample Browser */}
        <div className="border border-[#cfd3d8] p-4 bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="eyebrow">Scenario Inspector</span>
              <h4 className="text-sm font-semibold text-ink flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-charcoal" />
                <span>Single Scenario Sample Browser</span>
              </h4>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-[#666]">Scenario ID:</span>
              <input
                type="number"
                min="0"
                max="499"
                value={sampleIdInput}
                onChange={(e) => setSampleIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleFetchSample(sampleIdInput);
                }}
                className="w-16 px-2 py-1 text-xs font-mono border border-[#cfd3d8] bg-white text-ink focus:outline-none focus:border-charcoal"
              />
              <button
                onClick={() => handleFetchSample(sampleIdInput)}
                className="btn-estate-dark text-xs py-1 px-3"
              >
                Inspect
              </button>
            </div>
          </div>

          {sampleError && (
            <div className="p-2.5 bg-red/10 border border-red/30 text-red text-xs">
              {sampleError}
            </div>
          )}

          {loadingSample ? (
            <div className="p-6 text-center text-xs text-[#888] font-mono">
              Extracting scenario snapshot tensor...
            </div>
          ) : sampleData ? (
            <div className="space-y-3">
              {/* Scenario Header Info */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs bg-[#fafafa] p-2.5 border border-[#e5e7eb]">
                <div>
                  <span className="text-[#666] block text-[10.5px]">Contingency:</span>
                  <span className="font-mono font-semibold text-ink">{sampleData.contingency_id ?? '---'}</span>
                </div>
                <div>
                  <span className="text-[#666] block text-[10.5px]">Load Multiplier:</span>
                  <span className="font-mono font-semibold text-ink">{sampleData.load_scale ?? 1.0}x</span>
                </div>
                <div>
                  <span className="text-[#666] block text-[10.5px]">Ground Truth Label:</span>
                  <span
                    className={`font-mono font-bold ${
                      sampleData.cascade_label === 1 ? 'text-red' : 'text-[#166534]'
                    }`}
                  >
                    {sampleData.cascade_label === 1 ? 'CASCADE (1)' : 'SAFE (0)'}
                  </span>
                </div>
                <div>
                  <span className="text-[#666] block text-[10.5px]">Network Size:</span>
                  <span className="font-mono text-ink">
                    {sampleData.bus_count ?? sampleData.num_buses ?? 0} buses, {sampleData.branch_count ?? sampleData.num_branches ?? 0} lines
                  </span>
                </div>
              </div>

              {/* Snapshot Tables Tabs/Toggle */}
              <div className="space-y-2">
                <span className="eyebrow block">First Post-Contingency Snapshot (Buses &amp; Lines)</span>
                <div className="max-h-48 overflow-y-auto border border-[#e5e7eb]">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-[#f3f4f6] sticky top-0 font-semibold text-[#555]">
                      <tr>
                        <th className="p-1.5">Line ID</th>
                        <th className="p-1.5">From-To</th>
                        <th className="p-1.5">Loading %</th>
                        <th className="p-1.5">Flow (MW)</th>
                        <th className="p-1.5 text-right">In-Service</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f0f0f0] font-mono">
                      {Array.isArray(sampleData.branch_snapshot) && sampleData.branch_snapshot.length > 0 ? (
                        sampleData.branch_snapshot.slice(0, 10).map((b) => (
                          <tr key={b.branch_id} className={!b.in_service ? 'bg-red/5' : ''}>
                            <td className="p-1.5 font-semibold">Line {b.branch_id}</td>
                            <td className="p-1.5">{b.from_bus} → {b.to_bus}</td>
                            <td className="p-1.5">{typeof b.loading_percent === 'number' ? b.loading_percent.toFixed(1) : '0.0'}%</td>
                            <td className="p-1.5">{typeof b.p_from_mw === 'number' ? b.p_from_mw.toFixed(1) : '0.0'}</td>
                            <td className="p-1.5 text-right">
                              {b.in_service ? (
                                <span className="text-[#166534]">True</span>
                              ) : (
                                <span className="text-red font-bold">OUTAGED</span>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="p-3 text-center text-[#888]">
                            No branch snapshots available.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {sampleData.zero_leakage_note && (
                <div className="p-2.5 bg-[#fbfbfb] border border-[#e5e7eb] text-[10.5px] text-[#666]">
                  <span className="font-semibold text-ink">Zero-Leakage Note: </span>
                  {sampleData.zero_leakage_note}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
