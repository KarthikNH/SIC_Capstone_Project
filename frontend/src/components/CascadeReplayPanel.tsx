import React, { useMemo } from 'react';
import { useGridStore } from '../store';
import type { Branch } from '../types';
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Activity,
  RefreshCw
} from 'lucide-react';
import {
  formatProbability,
  formatPercent,
  formatBranchName,
  getOutcomeCategory,
  CANONICAL_ALERT_THRESHOLD
} from '../utils/probability';
import { SuggestedFixCard } from './SuggestedFixCard';

interface CascadeReplayPanelProps {
  branches?: Branch[];
  isCompactHUD?: boolean;
}

export const CascadeReplayPanel: React.FC<CascadeReplayPanelProps> = ({
  branches: propBranches,
  isCompactHUD = false
}) => {
  const {
    branches: storeBranches,
    replayData,
    replayStepIndex,
    isPlayingReplay,
    loadingReplay,
    startCascadeReplay,
    stopCascadeReplay,
    setReplayStepIndex,
    togglePlayPauseReplay,
    replaySpeed,
    setReplaySpeed,
    outagedElements,
    prediction,
    fetchPrediction,
    stepForwardReplay,
    stepBackReplay,
    restartReplay
  } = useGridStore();

  const branches = propBranches || storeBranches || [];

  const totalSteps = replayData?.total_steps ?? 0;
  const isReplayComplete = replayData !== null && replayStepIndex >= totalSteps - 1;
  const isInitialStep = replayStepIndex === 0;

  // Build a lookup for branch names in IEEE 1-based notation: Line 3-11
  const branchNameMap = useMemo(() => {
    const map = new Map<number, string>();
    const busOffset = 1;
    branches.forEach((b) => {
      map.set(b.id, formatBranchName(b.from_bus, b.to_bus, busOffset));
    });
    return map;
  }, [branches]);

  // Helper to consistently format any branch in IEEE 1-based notation
  const getBranchLabel = (id: number | string) => {
    const numId = typeof id === 'number' ? id : parseInt(String(id).replace('line_', '').replace('branch_', ''), 10);
    if (!isNaN(numId) && branchNameMap.has(numId)) {
      return branchNameMap.get(numId)!;
    }
    return formatBranchName(id, branches);
  };

  const currentStep = replayData && replayStepIndex >= 0 ? replayData.steps[replayStepIndex] : null;

  // Compute overloaded count at current step (> 100% loading)
  const currentOverloadedCount = useMemo(() => {
    if (!currentStep?.branch_loadings) return 0;
    const cumTripped = new Set(currentStep.cumulative_tripped_branches || []);
    let count = 0;
    Object.entries(currentStep.branch_loadings).forEach(([bId, loading]) => {
      const idNum = parseInt(bId, 10);
      if (!cumTripped.has(idNum) && loading >= 100.0) {
        count++;
      }
    });
    return count;
  }, [currentStep]);

  // Names of newly tripped lines at this step
  const newlyTrippedNames = useMemo(() => {
    if (!currentStep?.newly_tripped_branches || currentStep.newly_tripped_branches.length === 0) {
      return '';
    }
    return currentStep.newly_tripped_branches
      .map((id) => getBranchLabel(id))
      .join(' and ');
  }, [currentStep, branchNameMap, branches]);

  // Plain-language step status message
  const liveStatusText = useMemo(() => {
    if (!replayData || !currentStep) return '';
    if (replayStepIndex === 0) {
      const initialOutages = outagedElements.length > 0
        ? outagedElements.map((x) => getBranchLabel(x)).join(' and ')
        : 'Initial disturbance';
      return `Step 1 of ${totalSteps}. ${initialOutages} applied. Calculating immediate t=0+ post-disturbance power flow state.`;
    }

    if (currentStep.newly_tripped_branches && currentStep.newly_tripped_branches.length > 0) {
      const tripText = `${newlyTrippedNames} tripped because they were above 100% of their limit.`;
      const riskText = currentOverloadedCount > 0
        ? ` ${currentOverloadedCount} more line(s) at risk.`
        : ' Remaining lines stabilized within limits.';
      return `Step ${replayStepIndex + 1} of ${totalSteps}. ${tripText}${riskText}`;
    }

    if (isReplayComplete) {
      if (replayData.cascade === 1) {
        return `Step ${replayStepIndex + 1} of ${totalSteps}. Cascade progression reached terminal state: ${replayData.termination_reason}.`;
      }
      return `Step ${replayStepIndex + 1} of ${totalSteps}. Outage contained. No further lines tripped.`;
    }

    return `Step ${replayStepIndex + 1} of ${totalSteps}. System state evaluated.`;
  }, [replayData, currentStep, replayStepIndex, totalSteps, outagedElements, newlyTrippedNames, currentOverloadedCount, isReplayComplete, branches]);

  // Cumulative running counters (match final card exactly when replay completes)
  const runningCounters = useMemo(() => {
    if (!currentStep || !replayData) return null;
    const initialCount = outagedElements.length;

    // Use backend-calculated cumulative values
    const extraTrips = isReplayComplete
      ? replayData.additional_trips
      : (currentStep.cumulative_extra_trips !== undefined
          ? currentStep.cumulative_extra_trips
          : Math.max(0, (currentStep.cumulative_tripped_branches?.length ?? 0) - initialCount));

    const loadShedMw = isReplayComplete
      ? replayData.final_load_shed_mw
      : (currentStep.cumulative_load_shed_mw !== undefined
          ? currentStep.cumulative_load_shed_mw
          : (currentStep.load_shed_mw ?? 0));

    const loadShedPct = isReplayComplete
      ? formatPercent(replayData.final_load_shed_fraction * 100)
      : (currentStep.cumulative_load_shed_fraction !== undefined
          ? formatPercent(currentStep.cumulative_load_shed_fraction * 100)
          : formatPercent((currentStep.load_shed_fraction ?? 0) * 100));

    const isolatedBuses = isReplayComplete
      ? (replayData.final_isolated_buses_count ?? (replayData.steps[replayData.steps.length - 1]?.islanded_buses?.length ?? 0))
      : (currentStep.cumulative_isolated_buses?.length ?? (currentStep.islanded_buses?.length ?? 0));

    return { extraTrips, loadShedMw: loadShedMw.toFixed(1), loadShedPct, isolatedBuses };
  }, [currentStep, replayData, isReplayComplete, outagedElements.length]);

  // One-sentence outcome explanation
  const outcomeExplanation = useMemo(() => {
    if (!replayData) return '';
    const initialDesc = outagedElements.length > 0
      ? outagedElements.map((x) => getBranchLabel(x)).join(' and ')
      : 'Initial line outage';

    if (replayData.additional_trips === 0) {
      return `Outage contained. Losing ${initialDesc} did not overload any other branches, so no cascade occurred.`;
    }

    // Step 1 tripped lines
    const step1Lines = replayData.steps[1]?.newly_tripped_branches || [];
    const step1Name = step1Lines.map((id) => getBranchLabel(id)).join(' and ') || 'subsequent lines';

    if (replayData.cascade === 1) {
      if (replayData.total_steps > 2) {
        const step2Lines = replayData.steps[2]?.newly_tripped_branches || [];
        const step2Name = step2Lines.map((id) => getBranchLabel(id)).join(' and ');
        if (step2Name) {
          return `Losing ${initialDesc} overloaded ${step1Name}, which tripped and pushed ${step2Name} over limit, triggering an uncontrolled cascade.`;
        }
      }
      return `Losing ${initialDesc} overloaded ${step1Name}, causing a cascading failure with ${replayData.additional_trips} additional line trips and ${formatPercent(replayData.final_load_shed_fraction * 100)} load shed.`;
    }

    return `Outage contained. Losing ${initialDesc} caused localized tripping of ${replayData.additional_trips} line(s) (${step1Name}), but the grid stabilized without systemic cascade.`;
  }, [replayData, outagedElements, branchNameMap, branches]);

  // Prediction vs Reality using Single Source of Truth
  const outcomeCardData = useMemo(() => {
    if (!replayData) return null;

    if (!prediction) {
      return {
        isUnavailable: true,
        text: 'Prediction unavailable'
      };
    }

    const prob = prediction.probability ?? prediction.cascade_probability ?? null;
    const threshold = prediction.alert_threshold ?? prediction.operating_threshold ?? CANONICAL_ALERT_THRESHOLD;
    const predictedCascade = prediction.predicted_cascade ?? (typeof prob === 'number' && prob >= threshold);
    const actualCascade = replayData.actual_cascade ?? (replayData.cascade === 1);

    if (prob === null || typeof prob !== 'number' || isNaN(prob)) {
      return {
        isUnavailable: true,
        text: 'Prediction unavailable'
      };
    }

    const outcomeCategory = getOutcomeCategory(predictedCascade, actualCascade);
    const probFormatted = formatProbability(prob);
    const thresholdFormatted = formatPercent(threshold * 100, 0);

    const criterionExplanation = replayData.criterion_explanation || (
      actualCascade
        ? `Counted as a cascade because ${
            replayData.additional_trips >= (replayData.k_extra_trips ?? 3)
              ? `subsequent branch trips reached ${replayData.additional_trips} (threshold >= ${replayData.k_extra_trips ?? 3})`
              : `load shed reached ${formatPercent(replayData.final_load_shed_fraction * 100)} (threshold >= ${formatPercent((replayData.load_shed_threshold ?? 0.15) * 100)})`
          }.`
        : 'Outage contained: additional branch trips remained below 3 and relative load shed remained below 15%.'
    );

    return {
      isUnavailable: false,
      category: outcomeCategory,
      predictedCascade,
      actualCascade,
      probFormatted,
      thresholdFormatted,
      alertLevel: prediction.alert_level || (prob >= 0.70 ? 'High' : prob >= threshold ? 'Medium' : 'Low'),
      criterionExplanation
    };
  }, [replayData, prediction]);

  // Before / After toggle
  const isShowingBefore = replayStepIndex === 0;
  const toggleBeforeAfter = () => {
    if (!replayData) return;
    if (isShowingBefore) {
      setReplayStepIndex(totalSteps - 1);
    } else {
      setReplayStepIndex(0);
    }
  };

  return (
    <div className={`space-y-3 ${isCompactHUD ? 'text-xs' : ''}`}>
      {/* 1. Main Replay Control Deck */}
      <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-3 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0f0f0] pb-2.5">
          <div className="flex items-center gap-2">
            <span className="eyebrow flex items-center gap-1.5 text-charcoal">
              <Sparkles className="w-3.5 h-3.5 text-amber" />
              <span>Quasi-Dynamic Cascade Replay</span>
            </span>
            {replayData && (
              <span className="text-[11px] font-mono px-2 py-0.5 bg-[#f3f4f6] text-[#444] border border-[#e5e7eb]">
                Step {replayStepIndex + 1} of {totalSteps}
              </span>
            )}
          </div>

          {/* Speed Selector */}
          {replayData && (
            <div className="flex items-center gap-1">
              <span className="text-[10.5px] text-[#777] mr-1 select-none font-mono">Speed:</span>
              {([0.5, 1, 2] as const).map((spd) => (
                <button
                  key={spd}
                  onClick={() => setReplaySpeed(spd)}
                  className={`px-2 py-0.5 text-[11px] font-mono border transition-colors ${
                    replaySpeed === spd
                      ? 'bg-charcoal text-white border-charcoal font-semibold'
                      : 'bg-white text-[#555] border-[#cfd3d8] hover:border-charcoal'
                  }`}
                  title={`Replay speed ${spd}x`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          )}
        </div>

        {!replayData ? (
          <button
            onClick={startCascadeReplay}
            disabled={loadingReplay}
            className="btn-estate-dark w-full flex items-center justify-center gap-2 text-xs py-2.5 shadow-2xs"
          >
            {loadingReplay ? (
              <>
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>Simulating Quasi-Dynamic Cascade Trajectory...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Run Quasi-Dynamic Cascade Simulation</span>
              </>
            )}
          </button>
        ) : (
          <div className="space-y-3">
            {/* Playback Controls Row */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={togglePlayPauseReplay}
                className="btn-estate-dark flex-1 min-w-[120px] py-1.5 text-xs flex items-center justify-center gap-1.5 shadow-2xs"
                title={isPlayingReplay ? 'Pause automatic playback' : 'Play automatic playback'}
              >
                {isPlayingReplay ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{isPlayingReplay ? 'Pause' : 'Play'}</span>
              </button>

              <button
                onClick={stepBackReplay}
                disabled={isInitialStep}
                className="p-1.5 border border-[#cfd3d8] bg-white text-[#555] hover:text-ink disabled:opacity-40 disabled:hover:text-[#555] transition-colors"
                title="Step backward (previous step)"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={stepForwardReplay}
                disabled={isReplayComplete}
                className="p-1.5 border border-[#cfd3d8] bg-white text-[#555] hover:text-ink disabled:opacity-40 disabled:hover:text-[#555] transition-colors"
                title="Step forward (next step)"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={restartReplay}
                className="p-1.5 border border-[#cfd3d8] bg-white text-[#555] hover:text-ink transition-colors"
                title="Restart replay from Step 1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={stopCascadeReplay}
                className="px-2.5 py-1.5 text-xs border border-[#cfd3d8] bg-white text-[#666] hover:text-red transition-colors"
                title="Exit replay mode"
              >
                Exit
              </button>
            </div>

            {/* Step Timeline Track with Clickable Dots */}
            <div className="pt-1 pb-1">
              <div className="flex items-center justify-between text-[10.5px] text-[#777] font-mono mb-1.5">
                <span>Timeline:</span>
                <span>Click any step to inspect</span>
              </div>
              <div className="relative flex items-center justify-between gap-1 w-full px-2 py-1 bg-[#f9fafb] border border-[#e5e7eb]">
                {/* Connecting track line */}
                <div className="absolute left-4 right-4 top-1/2 -translate-y-1/2 h-0.5 bg-[#d1d5db] -z-0" />

                {Array.from({ length: totalSteps }).map((_, idx) => {
                  const isActive = idx === replayStepIndex;
                  const stepObj = replayData.steps[idx];
                  const hasTrips = (stepObj?.newly_tripped_branches?.length ?? 0) > 0;
                  const isInitial = idx === 0;

                  return (
                    <button
                      key={idx}
                      onClick={() => setReplayStepIndex(idx)}
                      className={`relative z-10 w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-bold transition-all shadow-xs ${
                        isActive
                          ? 'ring-2 ring-charcoal bg-ink text-white scale-110'
                          : hasTrips
                          ? 'bg-[#fee2e2] text-red border border-red hover:bg-red hover:text-white'
                          : isInitial
                          ? 'bg-[#e0f2fe] text-[#0369a1] border border-[#7dd3fc] hover:bg-[#0284c7] hover:text-white'
                          : 'bg-white text-[#555] border border-[#cfd3d8] hover:border-charcoal hover:text-ink'
                      }`}
                      title={`Step ${idx + 1}: ${stepObj?.description || ''}`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Live Status Card during replay (Plain Language + Running Counters + aria-live) */}
      {replayData && currentStep && (
        <div
          role="status"
          aria-live="polite"
          className="p-3.5 border border-[#cfd3d8] bg-[#fbfbfb] space-y-2.5 shadow-2xs"
        >
          <div className="flex items-start gap-2.5">
            <div className="w-5 h-5 rounded-full bg-charcoal/10 text-ink flex items-center justify-center shrink-0 mt-0.5">
              <Activity className="w-3.5 h-3.5 text-charcoal" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="eyebrow text-charcoal">Live Trajectory State</span>
                {isPlayingReplay && (
                  <span className="flex items-center gap-1.5 text-[10.5px] font-mono text-red font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-red animate-ping" />
                    SIMULATING
                  </span>
                )}
              </div>
              <p className="text-xs text-ink font-sans leading-relaxed mt-0.5 font-medium">
                {liveStatusText}
              </p>
            </div>
          </div>

          {/* Running Counters (Cumulative, matching final card) */}
          {runningCounters && (
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#e5e7eb] text-xs">
              <div className="bg-white p-2 border border-[#e5e7eb]">
                <span className="text-[#666] block text-[10.5px]">Extra Lines Tripped</span>
                <span className="font-mono font-bold text-ink text-sm">
                  {runningCounters.extraTrips} lines
                </span>
              </div>
              <div className="bg-white p-2 border border-[#e5e7eb]">
                <span className="text-[#666] block text-[10.5px]">Load Shed</span>
                <span className="font-mono font-bold text-ink text-sm">
                  {runningCounters.loadShedMw} MW <span className="text-[11px] text-[#777]">({runningCounters.loadShedPct})</span>
                </span>
              </div>
              <div className="bg-white p-2 border border-[#e5e7eb]">
                <span className="text-[#666] block text-[10.5px]">Isolated Buses</span>
                <span className="font-mono font-bold text-ink text-sm">
                  {runningCounters.isolatedBuses} buses
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. Final Outcome Card (Stays visible until reset or restart) */}
      {replayData && (
        <div className="p-4 border border-[#cfd3d8] bg-white space-y-3.5 shadow-xs">
          {/* Headline */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#e5e7eb] pb-3">
            <div className="flex items-center gap-3">
              {replayData.cascade === 1 ? (
                <div className="w-10 h-10 rounded-full bg-red/10 text-red flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-6 h-6 text-red" />
                </div>
              ) : (
                <div className="w-10 h-10 rounded-full bg-[#dcfce7] text-[#166534] flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-6 h-6 text-[#166534]" />
                </div>
              )}
              <div>
                <span className="eyebrow block">Cascade Simulation Result</span>
                <h3
                  className={`text-lg font-serif font-bold tracking-tight ${
                    replayData.cascade === 1 ? 'text-red' : 'text-[#166534]'
                  }`}
                >
                  {replayData.cascade === 1
                    ? 'Cascade occurred'
                    : replayData.additional_trips === 0
                    ? 'Outage contained. No further lines tripped.'
                    : 'Outage contained'}
                </h3>
              </div>
            </div>

            {/* Before / After Scene Toggle Button */}
            <button
              onClick={toggleBeforeAfter}
              className={`px-3 py-1.5 text-xs font-semibold border flex items-center gap-1.5 transition-colors shadow-2xs ${
                isShowingBefore
                  ? 'bg-amber/15 text-[#92400e] border-[#fde68a]'
                  : 'bg-charcoal text-white border-charcoal'
              }`}
              title="Toggle scene between pre-replay state and final cascade state"
            >
              {isShowingBefore ? <ToggleLeft className="w-4 h-4 text-amber" /> : <ToggleRight className="w-4 h-4 text-white" />}
              <span>{isShowingBefore ? 'Viewing Pre-Replay (t=0+)' : 'Viewing Final State'}</span>
            </button>
          </div>

          {/* Key Numbers Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            <div className="border border-[#e5e7eb] p-2.5 bg-[#fbfbfb]">
              <span className="text-[#666] block text-[10.5px]">Extra Lines Tripped</span>
              <span className="font-mono font-bold text-ink text-base">
                {replayData.additional_trips} lines
              </span>
            </div>
            <div className="border border-[#e5e7eb] p-2.5 bg-[#fbfbfb]">
              <span className="text-[#666] block text-[10.5px]">Total Load Shed</span>
              <span className="font-mono font-bold text-ink text-base">
                {replayData.final_load_shed_mw.toFixed(1)} MW
              </span>
              <span className="text-[10px] text-[#777] block font-mono">
                {formatPercent(replayData.final_load_shed_fraction * 100)} of demand
              </span>
            </div>
            <div className="border border-[#e5e7eb] p-2.5 bg-[#fbfbfb]">
              <span className="text-[#666] block text-[10.5px]">Isolated Buses</span>
              <span className="font-mono font-bold text-ink text-base">
                {replayData.steps[replayData.steps.length - 1]?.islanded_buses?.length ?? 0} buses
              </span>
            </div>
            <div className="border border-[#e5e7eb] p-2.5 bg-[#fbfbfb]">
              <span className="text-[#666] block text-[10.5px]">Cascade Iterations</span>
              <span className="font-mono font-bold text-ink text-base">
                {totalSteps} steps
              </span>
              <span className="text-[10px] text-[#777] block capitalize">
                {replayData.termination_reason.replace('_', ' ')}
              </span>
            </div>
          </div>

          {/* Prediction vs Reality Outcome Card with distinct wording & colour */}
          {outcomeCardData && (
            <div className="space-y-2">
              {outcomeCardData.isUnavailable || !outcomeCardData.category ? (
                <div className="p-3 border border-amber-300 bg-amber-50 text-xs flex items-center justify-between gap-2 text-amber-900">
                  <span>Prediction unavailable</span>
                  <button
                    onClick={() => fetchPrediction()}
                    className="px-2.5 py-1 bg-white border border-amber-400 text-amber-900 hover:bg-amber-100 flex items-center gap-1 font-mono text-[11px]"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Retry</span>
                  </button>
                </div>
              ) : (
                <div className={`p-3 border text-xs space-y-1.5 ${outcomeCardData.category.badgeClass}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase tracking-wider text-[10.5px] px-2 py-0.5 bg-white/70 border border-current">
                        {outcomeCardData.category.title}
                      </span>
                      <span className="font-semibold text-xs">
                        Predicted: {outcomeCardData.alertLevel} risk ({outcomeCardData.probFormatted}) | Actual: {outcomeCardData.actualCascade ? 'Cascade' : 'Contained'}
                      </span>
                    </div>
                    <span className="font-mono text-[10.5px] text-[#666]">
                      Threshold: {outcomeCardData.thresholdFormatted}
                    </span>
                  </div>

                  <p className="text-[11.5px] leading-relaxed font-sans text-ink/90">
                    {outcomeCardData.criterionExplanation}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* One-Sentence Plain Explanation */}
          <div className="p-3 bg-[#f9fafb] border border-[#e5e7eb] text-xs">
            <span className="eyebrow block text-charcoal mb-0.5">Physical Cause &amp; Effect:</span>
            <p className="text-ink leading-relaxed font-sans">
              {outcomeExplanation}
            </p>
          </div>
        </div>
      )}

      {/* 4. Suggested Fix Card (directly under outcome card) */}
      <SuggestedFixCard />
    </div>
  );
};
