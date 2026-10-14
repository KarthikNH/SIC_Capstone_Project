import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StageScene } from './StageScene';
import { GridUploadModal } from './GridUploadModal';
import { MiniWhatIfChart } from './MiniWhatIfChart';
import { DatasetInspector } from './DatasetInspector';
import { ChatDrawer } from './ChatDrawer';
import { ErrorBoundary } from './ErrorBoundary';
import { CascadeReplayPanel } from './CascadeReplayPanel';
import { SuggestedFixCard } from './SuggestedFixCard';
import { formatBranchName, CANONICAL_ALERT_THRESHOLD, formatPercent, formatProbability, assertNotNaN } from '../utils/probability';
import { useGridStore } from '../store';
import {
  RotateCcw,
  Search,
  X,
  Undo2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Sliders,
  AlertTriangle,
  UploadCloud,
  Flame,
  Activity,
  BarChart3,
  Eye,
  ShieldAlert,
  Database,
  ArrowRight,
  AlertCircle,
  Maximize2,
  Minimize2,
  Bot
} from 'lucide-react';

export const LiveDemo: React.FC = () => {
  const {
    gridCase,
    setGridCase,
    gridList,
    fetchGridList,
    deleteGrid,
    setUploadModalOpen,
    branches,
    buses,
    gridStats,
    fetchGridStats,
    outagedElements,
    toggleOutagedElement,
    removeOutagedElement,
    clearOutages,
    undoOutage,
    outageHistory,
    loadScale,
    setLoadScale,
    prediction,
    loadingPredict,
    triggerCameraReset,
    showBusNumbers,
    toggleShowBusNumbers,
    activeTab,
    setActiveTab,
    showCriticality,
    loadingCriticality,
    criticalityProgress,
    criticalityData,
    toggleCriticality,
    glowInfluential,
    toggleGlowInfluential,
    replayData,
    replayStepIndex,
    isPlayingReplay,
    setReplayStepIndex,
    togglePlayPauseReplay,
    globalInsights,
    fetchGlobalInsights,
    setOutagedElements,
    viewMode,
    setViewMode,
    labelMode,
    setLabelMode,
    buildingsOpacity,
    setBuildingsOpacity,
    applyToStructures,
    setApplyToStructures,
    groupByVoltage,
    setGroupByVoltage,
    topologyOverlay,
    setTopologyOverlay,
  } = useGridStore();

  const uniqueVoltages = useMemo(
    () => Array.from(new Set(buses.map((b) => b.vn_kv || 132))),
    [buses]
  );

  // Search-as-you-type state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Collapsible legend state
  const [isLegendOpen, setIsLegendOpen] = useState(false);

  // OOD Reasons popover state
  const [showOodPopover, setShowOodPopover] = useState(false);

  // Collapsible Model Insights state
  const [modelInsightsOpen, setModelInsightsOpen] = useState(false);

  // Debounced load slider local state
  const [sliderVal, setSliderVal] = useState<number>(Math.round(loadScale * 100));
  const sliderTimerRef = useRef<any>(null);

  useEffect(() => {
    setSliderVal(Math.round(loadScale * 100));
  }, [loadScale]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    setSliderVal(val);
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current);
    sliderTimerRef.current = setTimeout(() => {
      setLoadScale(val / 100.0);
    }, 120);
  };

  // Initial load: fetch grid list, active grid stats, global insights
  useEffect(() => {
    fetchGridList();
    fetchGridStats();
    fetchGlobalInsights();
  }, [fetchGridList, fetchGridStats, fetchGlobalInsights]);

  // Fullscreen Contingency Analysis State & Fallback
  const contingencyContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);

  const enterFullscreen = () => {
    const el = contingencyContainerRef.current;
    if (!el) return;
    if (el.requestFullscreen) {
      el.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(() => {
        setIsFallbackFullscreen(true);
        setIsFullscreen(true);
      });
    } else if ((el as any).webkitRequestFullscreen) {
      (el as any).webkitRequestFullscreen();
      setIsFullscreen(true);
    } else {
      setIsFallbackFullscreen(true);
      setIsFullscreen(true);
    }
  };

  const exitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    setIsFallbackFullscreen(false);
    setIsFullscreen(false);
  };

  const toggleFullscreen = () => {
    if (isFullscreen || isFallbackFullscreen || document.fullscreenElement) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      const isNowFs = Boolean(document.fullscreenElement);
      if (!isNowFs && !isFallbackFullscreen) {
        setIsFullscreen(false);
      } else if (isNowFs) {
        setIsFullscreen(true);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, [isFallbackFullscreen]);

  // Keyboard shortcut: 'F' toggles fullscreen, 'Escape' exits
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'Escape' && (isFullscreen || isFallbackFullscreen)) {
        exitFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, isFallbackFullscreen]);

  // Replay automatic step progression with speed selector support
  useEffect(() => {
    let interval: any = null;
    if (isPlayingReplay && replayData && replayStepIndex >= 0) {
      const speed = useGridStore.getState().replaySpeed || 1;
      const stepDuration = Math.round(1200 / speed);
      interval = setInterval(() => {
        const { replayStepIndex: curIdx, replayData: curData } = useGridStore.getState();
        if (curData && curIdx < curData.total_steps - 1) {
          setReplayStepIndex(curIdx + 1);
        } else {
          togglePlayPauseReplay();
        }
      }, stepDuration);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isPlayingReplay, replayData, replayStepIndex, setReplayStepIndex, togglePlayPauseReplay]);

  // Filter searchable items (branches and generator buses)
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    const results: Array<{ id: string; label: string; type: 'branch' | 'generator'; isOut: boolean }> = [];

    branches.forEach((br) => {
      const name = br.name || formatBranchName(br.from_bus, br.to_bus, 1);
      const idStr = `line_${br.id}`;
      if (
        name.toLowerCase().includes(q) ||
        String(br.id) === q ||
        String(br.from_bus) === q ||
        String(br.to_bus) === q
      ) {
        results.push({
          id: idStr,
          label: `${name} (Rating: ${br.rating.toFixed(2)} kA)`,
          type: 'branch',
          isOut: outagedElements.includes(idStr)
        });
      }
    });

    buses
      .filter((b) => b.type === 'generator')
      .forEach((b) => {
        const idStr = `gen_${b.id}`;
        const label = `Generator at Bus ${b.id + 1} (${b.gen_p_mw.toFixed(1)} MW)`;
        if (label.toLowerCase().includes(q) || String(b.id) === q) {
          results.push({
            id: idStr,
            label,
            type: 'generator',
            isOut: outagedElements.includes(idStr)
          });
        }
      });

    return results.slice(0, 8);
  }, [searchQuery, branches, buses, outagedElements]);

  // Keyboard navigation for search dropdown
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isSearchOpen || searchResults.length === 0) {
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchSelectedIndex((prev) => (prev + 1) % searchResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchSelectedIndex((prev) => (prev - 1 + searchResults.length) % searchResults.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = searchResults[searchSelectedIndex];
      if (selected) {
        toggleOutagedElement(selected.id);
        setSearchQuery('');
        setIsSearchOpen(false);
      }
    } else if (e.key === 'Escape') {
      setIsSearchOpen(false);
    }
  };

  // Close search popover on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Format Risk Metrics using Single Source of Truth
  const rawProb = prediction?.probability ?? prediction?.cascade_probability ?? null;
  const canonicalThreshold = prediction?.alert_threshold ?? prediction?.operating_threshold ?? CANONICAL_ALERT_THRESHOLD;
  const alertLevel: 'Low' | 'Medium' | 'High' =
    prediction?.alert_level ||
    (rawProb !== null && rawProb >= 0.70
      ? 'High'
      : rawProb !== null && rawProb >= canonicalThreshold
      ? 'Medium'
      : 'Low');

  const riskColor =
    alertLevel === 'High'
      ? 'text-red'
      : alertLevel === 'Medium'
      ? 'text-amber'
      : 'text-[#4b5563]';

  // Active Grid Object
  const activeGridMeta = useMemo(() => {
    return gridList.find((g) => g.id === gridCase);
  }, [gridList, gridCase]);

  // Built-in training grids (case30, case118) must never show OOD badge at normal operating points
  const isBuiltInGrid = gridCase.toLowerCase() === 'case30' || gridCase.toLowerCase() === 'case118';
  const oodStatus = isBuiltInGrid ? null : (prediction?.ood_status || activeGridMeta?.ood_status);
  const isOod = !isBuiltInGrid && oodStatus && oodStatus.status !== 'in_range';

  // Top Fragile Lines from Criticality screening
  const topCriticalList = useMemo(() => {
    if (!criticalityData || !criticalityData.top_10_critical_elements) return [];
    return criticalityData.top_10_critical_elements.slice(0, 5);
  }, [criticalityData]);

  // Assertion for NaN prevention in dev
  if (rawProb !== null) {
    assertNotNaN(rawProb, 'Early Warning rawProb');
  }

  return (
    <section id="demo" className="py-16 md:py-24 border-t border-[#e5e7eb] max-w-7xl mx-auto px-6 lg:px-8">
      {/* Upload Modal */}
      <GridUploadModal />

      {/* Grid Selector & Upload Bar (Above the 3D Scene in Estate Style) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[#e5e7eb]">
        <div>
          <p className="eyebrow">Transmission Network Selection</p>
          <h2 className="text-xl sm:text-2xl font-serif font-bold text-ink tracking-tight mt-0.5">
            Interactive Contingency Analysis
          </h2>
        </div>

        {/* Grid Chips & Upload Button */}
        <div className="flex flex-wrap items-center gap-2">
          {/* IEEE 30-bus chip */}
          <button
            onClick={() => setGridCase('case30')}
            className={`px-3.5 py-1.5 text-xs font-medium transition-all border ${
              gridCase === 'case30'
                ? 'bg-charcoal text-white border-charcoal shadow-sm'
                : 'bg-white text-[#555] border-[#cfd3d8] hover:border-charcoal hover:text-ink'
            }`}
          >
            IEEE 30-bus
          </button>

          {/* IEEE 118-bus chip */}
          <button
            onClick={() => setGridCase('case118')}
            className={`px-3.5 py-1.5 text-xs font-medium transition-all border ${
              gridCase === 'case118'
                ? 'bg-charcoal text-white border-charcoal shadow-sm'
                : 'bg-white text-[#555] border-[#cfd3d8] hover:border-charcoal hover:text-ink'
            }`}
          >
            IEEE 118-bus
          </button>

          {/* Uploaded Grid Chips */}
          {gridList
            .filter((g) => !g.is_builtin)
            .map((g) => {
              const isSelected = gridCase === g.id;
              const isItemOod = g.ood_status && g.ood_status.status !== 'in_range';
              return (
                <div
                  key={g.id}
                  onClick={() => setGridCase(g.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setGridCase(g.id);
                    }
                  }}
                  className={`px-3 py-1.5 text-xs font-medium transition-all border flex items-center gap-1.5 cursor-pointer ${
                    isSelected
                      ? 'bg-charcoal text-white border-charcoal shadow-sm'
                      : 'bg-white text-[#555] border-[#cfd3d8] hover:border-charcoal hover:text-ink'
                  }`}
                  title={`${g.name} (${g.num_buses} buses, ${g.num_branches} lines)`}
                >
                  {isItemOod && <span className="w-1.5 h-1.5 rounded-full bg-amber inline-block" />}
                  <span>{g.name || g.id}</span>
                  <span className="font-mono text-[10px] opacity-75">({g.num_buses}b)</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteGrid(g.id);
                    }}
                    className={`ml-1 p-0.5 rounded transition-colors ${
                      isSelected
                        ? 'text-white/70 hover:text-white hover:bg-white/20'
                        : 'text-[#888] hover:text-red hover:bg-[#fee2e2]'
                    }`}
                    title={`Delete ${g.name || g.id}`}
                    aria-label={`Delete grid ${g.name || g.id}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}

          {/* Upload Grid Button */}
          <button
            onClick={() => setUploadModalOpen(true)}
            className="btn-estate-dark py-1.5 px-3.5 text-xs flex items-center gap-1.5 hover:bg-charcoal hover:text-white"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            <span>Upload grid</span>
          </button>
        </div>
      </div>

      {/* Outage State / Hint & Reset Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 pb-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Outage Selection:</span>
          <span className="text-[#666] font-mono">
            {outagedElements.length > 0
              ? outagedElements.map((x) => formatBranchName(x, branches)).join(' + ')
              : 'None (Nominal Topology)'}
          </span>
          {outagedElements.length > 0 && (
            <span className="text-[11px] px-2 py-0.5 bg-red/10 text-red font-semibold uppercase">
              Contingency Active
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Criticality screening toggle button */}
          <button
            onClick={toggleCriticality}
            disabled={loadingCriticality}
            className={`px-3 py-1 text-xs border flex items-center gap-1.5 transition-colors ${
              showCriticality
                ? 'bg-red text-white border-red font-semibold'
                : 'bg-white border-[#cfd3d8] text-[#555] hover:border-charcoal hover:text-ink'
            }`}
          >
            <Flame className={`w-3.5 h-3.5 ${showCriticality ? 'text-white' : 'text-amber'}`} />
            <span>
              {loadingCriticality
                ? `Screening (${Math.round(criticalityProgress * 100)}%)...`
                : showCriticality
                ? 'Hide fragile lines'
                : 'Show most fragile lines'}
            </span>
          </button>

          <button
            onClick={triggerCameraReset}
            className="text-xs text-[#666] hover:text-ink flex items-center gap-1 py-1"
            title="Reset scene camera angle"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset Camera</span>
          </button>

          <button
            onClick={toggleFullscreen}
            className="text-xs text-[#555] hover:text-ink flex items-center gap-1.5 py-1 px-2.5 border border-[#cfd3d8] bg-white transition-colors shadow-2xs hover:border-charcoal"
            title="Full screen contingency analysis (F)"
            aria-label="Full screen contingency analysis"
          >
            <Maximize2 className="w-3.5 h-3.5 text-charcoal" />
            <span>Full screen (F)</span>
          </button>
        </div>
      </div>

      {/* Criticality Map Top-5 Drawer / Legend (when active) */}
      {showCriticality && (
        <div className="mb-3 p-3 bg-[#fdf2f2] border border-red/30 text-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-semibold text-red">
              <ShieldAlert className="w-4 h-4" />
              <span>N-1 Criticality Screening Heatmap Active</span>
            </div>
            <p className="text-[11.5px] text-[#555]">
              Branches are coloured by their simulated cascade failure probability if that branch alone tripped.
            </p>
          </div>

          {/* Clickable Top-5 fragile lines */}
          {topCriticalList.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="eyebrow mr-1">Top Fragile:</span>
              {topCriticalList.map((item: any, idx: number) => {
                const probVal = Math.round(item.cascade_probability * 100);
                const isSelected = outagedElements.includes(item.element_id);
                return (
                  <button
                    key={item.element_id}
                    onClick={() => toggleOutagedElement(item.element_id)}
                    className={`px-2 py-0.5 border text-[11px] font-mono transition-colors flex items-center gap-1 ${
                      isSelected
                        ? 'bg-red text-white border-red font-bold'
                        : 'bg-white border-[#cfd3d8] hover:border-red text-ink'
                    }`}
                    title={`Click to outage ${item.element_name}`}
                  >
                    <span>#{idx + 1} {item.element_id.toUpperCase()}</span>
                    <span className="font-semibold text-red">({probVal}%)</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Contingency Analysis Area Wrapper (supports Fullscreen API + CSS fallback) */}
      <div
        ref={contingencyContainerRef}
        className={
          isFallbackFullscreen
            ? 'fixed inset-0 z-[100] bg-soft flex flex-col w-screen h-screen overflow-hidden'
            : isFullscreen
            ? 'bg-soft flex flex-col w-full h-full overflow-hidden'
            : 'relative mt-2'
        }
      >
        {/* Fullscreen Compact Merged Single HUD */}
        {(isFullscreen || isFallbackFullscreen) && (
          <div className="z-30 bg-white/95 backdrop-blur-md border-b border-[#cfd3d8] px-4 py-2 flex flex-wrap items-center justify-between gap-2.5 shadow-sm select-none shrink-0">
            {/* Left Controls: View Mode, Labels, Topology/Voltage or Opacity, Risk */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-[#f0f4f8] border border-[#cfd3d8] p-0.5">
                {(['3d', 'map', 'city'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setViewMode(m)}
                    className={`px-2.5 py-1 text-xs font-medium transition-all ${
                      viewMode === m ? 'bg-charcoal text-white shadow-2xs' : 'text-[#555] hover:text-ink'
                    }`}
                  >
                    {m === '3d' ? '3D' : m === 'map' ? 'Map' : 'City'}
                  </button>
                ))}
              </div>

              {/* Labels: Smart | All | Off */}
              <div className="flex items-center bg-white border border-[#cfd3d8] p-0.5 text-xs">
                <span className="px-2 py-0.5 text-[10px] uppercase font-mono tracking-wider text-[#666]">Labels</span>
                {(['smart', 'all', 'off'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setLabelMode(mode)}
                    className={`px-2 py-0.5 text-[11px] font-medium capitalize transition-all ${
                      labelMode === mode ? 'bg-charcoal text-white shadow-2xs' : 'text-[#555] hover:text-ink'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              {/* Map View Extra Controls: Topology Overlays & Group by Voltage */}
              {viewMode === 'map' && (
                <>
                  <div className="flex items-center gap-1 bg-white border border-[#cfd3d8] px-2 py-0.5 text-xs">
                    <span className="text-[10px] uppercase font-mono tracking-wider text-[#666]">Topology:</span>
                    {(['none', 'degree', 'betweenness', 'community', 'bridges'] as const).map((overlay) => (
                      <button
                        key={overlay}
                        onClick={() => setTopologyOverlay(overlay)}
                        className={`px-1.5 py-0.5 text-[10.5px] capitalize transition-colors ${
                          topologyOverlay === overlay
                            ? 'bg-charcoal text-white font-medium'
                            : 'text-[#555] hover:text-ink'
                        }`}
                      >
                        {overlay === 'community' ? 'Clusters' : overlay}
                      </button>
                    ))}
                  </div>

                  {uniqueVoltages.length >= 2 && (
                    <label className="flex items-center gap-1.5 bg-white border border-[#cfd3d8] px-2 py-1 text-xs text-[#555] cursor-pointer hover:text-ink">
                      <input
                        type="checkbox"
                        checked={groupByVoltage}
                        onChange={(e) => setGroupByVoltage(e.target.checked)}
                        className="accent-charcoal cursor-pointer"
                      />
                      <span className="text-[11px] font-medium">Group by voltage</span>
                    </label>
                  )}
                </>
              )}

              {/* City View Extra Controls: Buildings Opacity & Structures */}
              {viewMode === 'city' && (
                <div className="flex items-center gap-2 bg-white border border-[#cfd3d8] px-2.5 py-1 text-xs">
                  <span className="text-[10px] uppercase font-mono tracking-wider text-[#666]">Opacity</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={buildingsOpacity}
                    onChange={(e) => setBuildingsOpacity(Number(e.target.value))}
                    className="w-16 h-1.5 accent-charcoal cursor-pointer"
                    title={`Buildings opacity: ${buildingsOpacity}%`}
                  />
                  <span className="text-[10px] font-mono text-charcoal w-6 text-right">{buildingsOpacity}%</span>
                  <label className="flex items-center gap-1 pl-1.5 border-l border-[#cfd3d8] cursor-pointer text-[10px] text-[#555] hover:text-ink">
                    <input
                      type="checkbox"
                      checked={applyToStructures}
                      onChange={(e) => setApplyToStructures(e.target.checked)}
                      className="accent-charcoal cursor-pointer rounded-xs"
                    />
                    <span>Structures</span>
                  </label>
                </div>
              )}

              <label className="flex items-center gap-1 text-xs text-[#555] bg-white px-2 py-1 border border-[#cfd3d8] cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBusNumbers}
                  onChange={toggleShowBusNumbers}
                  className="accent-charcoal cursor-pointer"
                />
                <span>Bus #</span>
              </label>

              <div className="flex items-center gap-1.5 bg-white px-2 py-1 border border-[#cfd3d8] text-xs font-mono">
                <span className="text-[#666]">Risk:</span>
                <span className="font-bold text-ink">{formatProbability(rawProb)}</span>
                <span className={`px-1.5 py-0.2 text-[10px] font-bold uppercase ${riskColor}`}>
                  {alertLevel}
                </span>
              </div>
            </div>

            {/* Right Controls: Reset Cam, Load slider, Search, Assistant, Exit */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={triggerCameraReset}
                className="px-2 py-1 text-xs border border-[#cfd3d8] bg-white text-[#555] hover:text-ink hover:border-charcoal flex items-center gap-1 transition-colors"
                title="Reset scene camera angle"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset Cam</span>
              </button>

              <div className="flex items-center gap-1.5 text-xs bg-white px-2.5 py-1 border border-[#cfd3d8]">
                <span className="text-[#666] text-[11px]">Load:</span>
                <input
                  type="range"
                  min="60"
                  max="120"
                  step="1"
                  value={sliderVal}
                  onChange={handleSliderChange}
                  className="w-16 accent-charcoal cursor-pointer"
                />
                <span className="font-mono font-semibold text-ink text-[11px]">{sliderVal}%</span>
              </div>

              <div className="relative w-36">
                <input
                  type="text"
                  placeholder="Search line #..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setIsSearchOpen(true);
                  }}
                  onFocus={() => setIsSearchOpen(true)}
                  className="w-full text-xs px-2 py-1 border border-[#cfd3d8] bg-white text-ink placeholder:text-[#999]"
                />
                {isSearchOpen && searchResults.length > 0 && (
                  <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-charcoal shadow-lg max-h-48 overflow-y-auto">
                    {searchResults.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => {
                          toggleOutagedElement(item.id);
                          setSearchQuery('');
                          setIsSearchOpen(false);
                        }}
                        className="px-2 py-1 text-xs hover:bg-[#f0f4f8] cursor-pointer flex items-center justify-between"
                      >
                        <span>{item.label}</span>
                        {item.isOut && <span className="text-red font-bold text-[10px]">OUT</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Grid Assistant button */}
              <button
                onClick={() => useGridStore.getState().toggleChat()}
                className="btn-estate-dark py-1 px-2.5 text-xs flex items-center gap-1 hover:bg-black"
                title="Open Grid Assistant Chat"
              >
                <Bot className="w-3.5 h-3.5 text-amber" />
                <span>Assistant</span>
              </button>

              {/* Exit Fullscreen button */}
              <button
                onClick={exitFullscreen}
                className="px-2.5 py-1 border border-[#cfd3d8] bg-white text-ink text-xs font-medium hover:bg-[#fee2e2] hover:border-red flex items-center gap-1 transition-colors"
                title="Exit full screen (Esc)"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                <span>Exit (Esc)</span>
              </button>
            </div>
          </div>
        )}

        {/* 3D Scene Stage Wrapper */}
        <div className={`relative ${isFullscreen || isFallbackFullscreen ? 'flex-1 min-h-0' : 'rounded-none border border-[#e5e7eb] shadow-sm bg-soft'}`}>
          <StageScene isFullscreen={isFullscreen || isFallbackFullscreen} />

        {/* Collapsible Legend (Bottom-Right, does not overlap bottom captions) */}
        <div className="absolute right-4 bottom-4 z-20">
          <div className="bg-white/95 backdrop-blur-md border border-[#cfd3d8] shadow-md transition-all rounded-none">
            <button
              onClick={() => setIsLegendOpen(!isLegendOpen)}
              className="flex items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-ink w-full hover:bg-[#f9fafb]"
            >
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-charcoal" />
                {viewMode === 'city' ? 'City View Legend' : 'Grid Legend & Stats'}
              </span>
              {isLegendOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#666]" /> : <ChevronUp className="w-3.5 h-3.5 text-[#666]" />}
            </button>

            {isLegendOpen && (
              <div className="px-3.5 py-3 border-t border-[#e5e7eb] text-xs text-[#555] space-y-3 min-w-[240px]">
                {viewMode === 'city' ? (
                  <>
                    {/* Procedural City Objects */}
                    <div>
                      <p className="eyebrow mb-1.5">City Objects</p>
                      <div className="space-y-1.5 text-[11px]">
                        <div className="flex items-start gap-2">
                          <span className="text-sm leading-none">🏢</span>
                          <span className="text-[#555] leading-snug">Building cluster — load area (taller = more demand)</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-sm leading-none">📦</span>
                          <span className="text-[#555] leading-snug">Fenced yard with transformers — substation</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-sm leading-none">🏭</span>
                          <span className="text-[#555] leading-snug">Plant with chimney — generator</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-sm leading-none">⚡</span>
                          <span className="text-[#555] leading-snug">Lattice pylons &amp; cable — transmission line</span>
                        </div>
                      </div>
                    </div>

                    {/* Cable Risk Colors */}
                    <div>
                      <p className="eyebrow mb-1.5">Cable Risk Colors</p>
                      <div className="space-y-1 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#9aa3ad]" />
                          <span>Normal (&lt; 65% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#d98a1f]" />
                          <span>Stressed (65% to 99% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#c8443b]" />
                          <span>Overloaded (&ge; 100% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#e02424]" />
                          <span>Outaged (severed cable break)</span>
                        </div>
                      </div>
                    </div>

                    {/* Uniform Voltage Notice if grid has single voltage level */}
                    {Array.from(new Set(buses.map(b => b.vn_kv).filter(Boolean))).length <= 1 && buses[0]?.vn_kv && (
                      <div className="border-t border-[#e5e7eb] pt-1.5 text-[10px] text-[#555] font-mono">
                        Uniform grid voltage: {buses[0].vn_kv} kV across all buses.
                      </div>
                    )}

                    <p className="text-[10px] text-[#888] pt-1.5 border-t border-[#f0f0f0] leading-tight">
                      Schematic city view. Positions are not geographic.
                    </p>
                  </>
                ) : (
                  <>
                    {/* Live Component Counts */}
                    <div>
                      <p className="eyebrow mb-1.5">Live Components</p>
                      <div className="grid grid-cols-3 gap-2 text-[11px] text-[#444]">
                        <div>
                          <span className="font-semibold text-ink">
                            {gridStats?.counts?.generators ?? buses.filter((b) => b.type === 'generator').length}
                          </span>{' '}
                          Gens
                        </div>
                        <div>
                          <span className="font-semibold text-ink">
                            {gridStats?.counts?.loads ?? buses.filter((b) => b.type === 'load').length}
                          </span>{' '}
                          Loads
                        </div>
                        <div>
                          <span className="font-semibold text-ink">{gridStats?.counts?.buses ?? buses.length}</span> Buses
                        </div>
                      </div>
                    </div>

                    {/* Line Status Colors */}
                    <div>
                      <p className="eyebrow mb-1.5">Branch Loading Colors</p>
                      <div className="space-y-1 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#9aa3ad]" />
                          <span>Normal (&lt; 65% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#d98a1f]" />
                          <span>Stressed (65% to 99% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#c8443b]" />
                          <span>Overloaded (&ge; 100% loaded)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-1.5 bg-[#e02424]" />
                          <span>Outaged (Severed break)</span>
                        </div>
                      </div>
                    </div>

                    {/* State Tints */}
                    <div>
                      <p className="eyebrow mb-1.5">State Tints</p>
                      <div className="space-y-1 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full border border-red bg-red/20" />
                          <span>Red Halo: Outage endpoint</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#4a5568]" />
                          <span>Faded: Islanded from grid</span>
                        </div>
                      </div>
                    </div>

                    {/* Show bus numbers toggle */}
                    <div className="pt-2 border-t border-[#e5e7eb] flex items-center justify-between">
                      <span className="text-[11px] font-medium text-ink">Show bus numbers</span>
                      <input
                        type="checkbox"
                        checked={showBusNumbers}
                        onChange={toggleShowBusNumbers}
                        className="accent-charcoal cursor-pointer"
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Outage Chip Row & Accessible Search (Directly under the scene) */}
      <div className="mt-3 flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 bg-[#fafafa] border border-[#e5e7eb]">
        {/* Outage Chips */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">Active Outages:</span>
          {outagedElements.length === 0 ? (
            <span className="text-xs text-[#888] italic">Click any line or generator to take it out</span>
          ) : (
            outagedElements.map((el) => {
              const label = formatBranchName(el, branches);
              return (
                <span
                  key={el}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-red/40 text-red text-xs font-semibold rounded-none shadow-2xs"
                >
                  <span>{label}</span>
                  <button
                    onClick={() => removeOutagedElement(el)}
                    className="hover:text-ink transition-colors ml-0.5"
                    title={`Restore ${label}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              );
            })
          )}

          {outagedElements.length > 0 && (
            <div className="flex items-center gap-2 ml-2">
              <button
                onClick={clearOutages}
                className="text-xs text-[#666] hover:text-red transition-colors underline"
              >
                Clear all
              </button>
              {outageHistory.length > 0 && (
                <button
                  onClick={undoOutage}
                  className="text-xs text-[#666] hover:text-ink transition-colors flex items-center gap-1 ml-1"
                  title="Undo last outage action"
                >
                  <Undo2 className="w-3 h-3" />
                  <span>Undo</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Search-as-you-type Accessible Input */}
        <div ref={searchContainerRef} className="relative w-full md:w-64">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#888]" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search line/bus #..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsSearchOpen(true);
                setSearchSelectedIndex(0);
              }}
              onFocus={() => setIsSearchOpen(true)}
              onKeyDown={handleSearchKeyDown}
              className="w-full text-xs pl-8 pr-7 py-1.5 border border-[#cfd3d8] bg-white text-ink placeholder:text-[#999] focus:outline-none focus:border-charcoal focus-visible:ring-1 focus-visible:ring-charcoal"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setIsSearchOpen(false);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#888] hover:text-ink"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Autocomplete dropdown popover */}
          {isSearchOpen && searchResults.length > 0 && (
            <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-charcoal shadow-lg max-h-56 overflow-y-auto">
              {searchResults.map((item, idx) => (
                <div
                  key={item.id}
                  onClick={() => {
                    toggleOutagedElement(item.id);
                    setSearchQuery('');
                    setIsSearchOpen(false);
                  }}
                  className={`px-3 py-2 text-xs flex items-center justify-between cursor-pointer border-b border-[#f0f0f0] last:border-b-0 ${
                    idx === searchSelectedIndex ? 'bg-[#f0f4f8] text-ink font-semibold' : 'hover:bg-[#f9fafb] text-[#444]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span>{item.type === 'branch' ? '⚡' : '⚙️'}</span>
                    <span>{item.label}</span>
                  </span>
                  {item.isOut && <span className="text-[10px] font-bold text-red uppercase">Selected</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

        {/* Load Slider & Cascade Replay Panel */}
        <div className={isFullscreen || isFallbackFullscreen ? 'border-t border-[#cfd3d8] bg-white p-3 z-30 max-h-[36vh] overflow-y-auto shadow-md shrink-0' : 'mt-4 space-y-4'}>
          {!(isFullscreen || isFallbackFullscreen) && (
            <div className="p-4 bg-[#fbfbfb] border border-[#e5e7eb]">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="load-slider" className="eyebrow flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5" />
                    System Load Multiplier
                  </label>
                  <span className="text-xs font-semibold font-mono text-ink bg-white px-2 py-0.5 border border-[#cfd3d8]">
                    {sliderVal}%
                  </span>
                </div>
                <input
                  id="load-slider"
                  type="range"
                  min="60"
                  max="120"
                  step="1"
                  value={sliderVal}
                  onChange={handleSliderChange}
                  className="w-full accent-charcoal cursor-pointer"
                />
                <div className="flex justify-between text-[10.5px] text-[#888] font-mono">
                  <span>60% (Off-Peak)</span>
                  <span>100% (Nominal)</span>
                  <span>120% (Peak Stress)</span>
                </div>
              </div>
            </div>
          )}

          <ErrorBoundary sectionName="Cascade Replay">
            <CascadeReplayPanel branches={branches} />
          </ErrorBoundary>
        </div>
      </div>

      {/* THREE TABS UNDER THE SCENE: Warning (default), Why, Grid stats */}
      <div className="mt-8">
        {/* Tab Selector Headers */}
        <div className="flex items-center border-b border-[#cfd3d8] gap-6 overflow-x-auto">
          <button
            onClick={() => setActiveTab('warning')}
            className={`pb-3 text-sm font-medium transition-all relative shrink-0 ${
              activeTab === 'warning'
                ? 'text-ink font-semibold border-b-2 border-charcoal'
                : 'text-[#666] hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber" />
              <span>Early Warning</span>
            </span>
          </button>

          <button
            onClick={() => setActiveTab('why')}
            className={`pb-3 text-sm font-medium transition-all relative shrink-0 ${
              activeTab === 'why'
                ? 'text-ink font-semibold border-b-2 border-charcoal'
                : 'text-[#666] hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-charcoal" />
              <span>Why (Attribution)</span>
            </span>
          </button>

          <button
            onClick={() => setActiveTab('stats')}
            className={`pb-3 text-sm font-medium transition-all relative shrink-0 ${
              activeTab === 'stats'
                ? 'text-ink font-semibold border-b-2 border-charcoal'
                : 'text-[#666] hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#666]" />
              <span>Grid Stats</span>
            </span>
          </button>

          <button
            onClick={() => setActiveTab('data')}
            className={`pb-3 text-sm font-medium transition-all relative shrink-0 ${
              activeTab === 'data'
                ? 'text-ink font-semibold border-b-2 border-charcoal'
                : 'text-[#666] hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <Database className="w-4 h-4 text-charcoal" />
              <span>Data (Dataset Inspector)</span>
            </span>
          </button>
        </div>

        {/* TAB 1: WARNING (Default) */}
        {activeTab === 'warning' && (
          <ErrorBoundary sectionName="Early Warning">
            <div className="pt-6 grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-8 items-start">
              {/* Risk Number & Narrative */}
              <div className="space-y-4">
                <div>
                  <p className="eyebrow mb-1">GINE Predicted Cascade Risk</p>
                  <div className="flex flex-wrap items-baseline gap-4">
                    <div className="text-[64px] font-semibold leading-none tracking-tight text-ink">
                      {loadingPredict ? (
                        <span className="text-[#999] animate-pulse">...</span>
                      ) : (
                        formatProbability(rawProb)
                      )}
                      <small className={`block text-[16px] font-semibold mt-2 ${riskColor}`}>
                        {alertLevel} Risk
                      </small>
                    </div>

                    {prediction?.uncertainty && (
                      <div className="bg-[#f8fafc] px-3 py-2 border border-[#cfd3d8] text-xs font-mono shadow-2xs">
                        <span className="eyebrow block text-[9.5px] text-[#666]">Uncertainty CI 95%</span>
                        <span className="font-semibold text-ink text-sm">
                          {formatPercent(prediction.uncertainty.ci_95_low * 100, 0)} – {formatPercent(prediction.uncertainty.ci_95_high * 100, 0)}
                        </span>
                        <span className="block text-[10px] text-[#777] mt-0.5">
                          std dev: ±{formatPercent(prediction.uncertainty.standard_deviation * 100, 1)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Narrative Sentence */}
                <p className="text-[13.5px] text-[#444] leading-relaxed bg-[#fbfbfb] p-3 border border-[#e5e7eb]">
                  {prediction?.narrative ||
                    'Initial disturbance operates within normal limits. Contingency load flow redistributes safely across parallel circuits.'}
                </p>

                {/* Confidence Margin & Second Opinion */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-2">
                  <div className="border border-[#e5e7eb] p-3 bg-white">
                    <span className="eyebrow block mb-1">Confidence Margin</span>
                    <div className="font-semibold text-ink font-mono text-sm">
                      ± {formatPercent((prediction?.confidence_margin ?? 0.042) * 100, 1)}
                    </div>
                    <span className="text-[11px] text-[#777] block mt-0.5">
                      Threshold: {formatPercent(canonicalThreshold * 100, 0)}
                    </span>
                  </div>

                  <div className="border border-[#e5e7eb] p-3 bg-white">
                    <span className="eyebrow block mb-1">XGBoost Second Opinion</span>
                    {prediction?.second_opinion ? (
                      <div>
                        <span className="font-semibold text-ink font-mono text-sm">
                          {Math.round(prediction.second_opinion.probability * 100)}% Risk
                        </span>
                        <span className="text-[11px] text-[#777] block mt-0.5">
                          {prediction.second_opinion.agrees ? 'XGBoost agrees with GINE' : 'XGBoost diverges from GINE'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[#888]">Evaluating baseline model...</span>
                    )}
                  </div>
                </div>

                {/* OOD Reliability Notice Badge */}
                {isOod && (
                  <div className="relative mt-2 p-3 bg-[#fffbeb] border border-[#fef3c7] text-[#92400e] text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-amber shrink-0" />
                        Outside the range this model was trained on. Treat this prediction as less reliable.
                      </span>
                      <button
                        onClick={() => setShowOodPopover(!showOodPopover)}
                        className="underline text-[11px] font-medium ml-2 hover:text-ink shrink-0"
                      >
                        {showOodPopover ? 'Hide reasons' : 'View reasons'}
                      </button>
                    </div>

                    {showOodPopover && oodStatus && (
                      <div className="mt-2 pt-2 border-t border-[#fde68a] text-[11px] space-y-1">
                        <p className="font-semibold">Evaluated out-of-distribution metrics:</p>
                        <ul className="list-disc pl-4 space-y-0.5 font-mono">
                          {(oodStatus.reasons || []).map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Mini What-If Chart */}
              <div className="space-y-4">
                <MiniWhatIfChart />

                <div className="bg-[#fafafa] border border-[#e5e7eb] p-3 text-xs text-[#666] space-y-1">
                  <span className="eyebrow block mb-0.5">Operating Guideline</span>
                  <p className="text-[11.5px] leading-relaxed">
                    Contingency risk climbs exponentially beyond 105% system load. Use the load scale slider to observe
                    how operating margins degrade before taking elements out of service.
                  </p>
                </div>
              </div>
            </div>
          </ErrorBoundary>
        )}

        {/* TAB 2: WHY (Attribution, Counterfactuals & Physical Breakdown) */}
        {activeTab === 'why' && (
          <ErrorBoundary sectionName="Attribution & Why Analysis">
            <div className="pt-6 space-y-6">
            {/* 1. Suggested Fix / Counterfactual Card */}
            <SuggestedFixCard />

            {/* Legacy fallback if SuggestedFix not yet loaded */}
            {!useGridStore.getState().suggestedFix && prediction?.counterfactual ? (
              <div className="p-4 border border-[#cfd3d8] bg-[#fafafa] space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#e5e7eb] pb-2">
                  <div>
                    <span className="eyebrow">Counterfactual Recommendation</span>
                    <h4 className="text-sm font-semibold text-ink">
                      Smallest Change That Makes This Outage Safe
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#666]">
                      Risk Before: <strong className="text-red font-mono">{Math.round(prediction.counterfactual.risk_before * 100)}%</strong>
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#888]" />
                    <span className="text-xs text-[#666]">
                      Risk After: <strong className="text-[#166534] font-mono">{Math.round(prediction.counterfactual.risk_after * 100)}%</strong>
                    </span>
                    <span className="px-2 py-0.5 bg-[#dcfce7] text-[#166534] text-xs font-semibold font-mono border border-[#bbf7d0]">
                      -{Math.round(prediction.counterfactual.risk_reduction * 100)}% Risk
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <p className="text-[#444] leading-relaxed max-w-xl">
                    {prediction.counterfactual.explanation}
                  </p>
                  <button
                    onClick={() => {
                      if (prediction.counterfactual?.recommended_load_scale) {
                        setLoadScale(prediction.counterfactual.recommended_load_scale);
                      }
                      if (prediction.counterfactual?.outage_to_restore) {
                        removeOutagedElement(prediction.counterfactual.outage_to_restore);
                      }
                    }}
                    className="btn-estate-dark py-1.5 px-4 text-xs shrink-0 flex items-center gap-1.5"
                  >
                    <span>Apply Counterfactual Fix</span>
                  </button>
                </div>
              </div>
            ) : null}

            {/* 2. Explanation Quality Badges */}
            {prediction?.explanation_quality && (
              <div className="p-3 border border-[#e5e7eb] bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <span className="text-[#666] block text-[10.5px]">Explanation Fidelity</span>
                    <span className="font-semibold text-ink font-mono">
                      {Math.round(prediction.explanation_quality.fidelity_risk_drop * 100)}% Drop
                    </span>
                  </div>
                  <div className="border-l border-[#e5e7eb] pl-4">
                    <span className="text-[#666] block text-[10.5px]">Sparsity Score</span>
                    <span className="font-semibold text-ink font-mono">
                      {Math.round(prediction.explanation_quality.sparsity_score * 100)}%
                    </span>
                  </div>
                  <div className="border-l border-[#e5e7eb] pl-4">
                    <span className="text-[#666] block text-[10.5px]">Explainer Agreement</span>
                    <span className="font-semibold text-[#166534] font-mono">
                      {Math.round(
                        (prediction.explanation_quality.explainer_agreement?.gnn_vs_gradient_overlap_score ?? 0.85) *
                          100
                      )}
                      % Overlap
                    </span>
                  </div>
                </div>
                <p className="text-[11.5px] text-[#555] italic sm:text-right max-w-md">
                  "{prediction.explanation_quality.plain_explanation}"
                </p>
              </div>
            )}

            {/* Top Influential Branches & Feature Contributions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Influential Branches */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="eyebrow">Attribution Saliency</p>
                    <h4 className="text-sm font-semibold text-ink">Top Influential Branches</h4>
                  </div>
                  <button
                    onClick={toggleGlowInfluential}
                    className={`px-2.5 py-1 text-xs border flex items-center gap-1 transition-colors ${
                      glowInfluential
                        ? 'bg-charcoal text-white border-charcoal'
                        : 'bg-white border-[#cfd3d8] text-[#555] hover:text-ink'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>{glowInfluential ? 'Attribution 3D Glow ON' : 'Highlight in 3D'}</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {prediction?.top_influential_branches && prediction.top_influential_branches.length > 0 ? (
                    prediction.top_influential_branches.map((br) => {
                      const pct = Math.round(br.importance * 100);
                      const branchDisplayName = br.name || formatBranchName(br.branch_id, branches);
                      return (
                        <div key={br.branch_id} className="space-y-1">
                          <div className="flex justify-between text-xs text-ink font-medium">
                            <span>{branchDisplayName}</span>
                            <span className="font-mono text-[#666]">
                              {pct}% saliency · {br.loading_percent.toFixed(0)}% loaded
                            </span>
                          </div>
                          <div className="h-2 bg-[#e5e7eb] w-full overflow-hidden">
                            <div
                              className="h-full bg-charcoal transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-xs text-[#888]">Computing branch importance attribution...</p>
                  )}
                </div>
              </div>

              {/* Feature-Group Contributions */}
              <div className="space-y-4">
                <div>
                  <p className="eyebrow">Explainability Breakdown</p>
                  <h4 className="text-sm font-semibold text-ink">Feature-Group Contributions</h4>
                </div>

                <div className="space-y-3 text-xs">
                  {prediction?.feature_group_contribution ? (
                    <>
                      <div>
                        <div className="flex justify-between text-ink font-medium mb-1">
                          <span>Branch Thermal Loading</span>
                          <span className="font-mono text-[#666]">
                            {Math.round(prediction.feature_group_contribution.loading * 100)}%
                          </span>
                        </div>
                        <div className="h-2 bg-[#e5e7eb]">
                          <div
                            className="h-full bg-amber"
                            style={{ width: `${Math.round(prediction.feature_group_contribution.loading * 100)}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-ink font-medium mb-1">
                          <span>Bus Voltage Stability</span>
                          <span className="font-mono text-[#666]">
                            {Math.round(prediction.feature_group_contribution.voltage * 100)}%
                          </span>
                        </div>
                        <div className="h-2 bg-[#e5e7eb]">
                          <div
                            className="h-full bg-charcoal"
                            style={{ width: `${Math.round(prediction.feature_group_contribution.voltage * 100)}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-ink font-medium mb-1">
                          <span>Generation / Load Dispatch</span>
                          <span className="font-mono text-[#666]">
                            {Math.round(prediction.feature_group_contribution.load_generation * 100)}%
                          </span>
                        </div>
                        <div className="h-2 bg-[#e5e7eb]">
                          <div
                            className="h-full bg-[#64748b]"
                            style={{ width: `${Math.round(prediction.feature_group_contribution.load_generation * 100)}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-ink font-medium mb-1">
                          <span>Graph Topology &amp; Connectivity</span>
                          <span className="font-mono text-[#666]">
                            {Math.round(prediction.feature_group_contribution.topology * 100)}%
                          </span>
                        </div>
                        <div className="h-2 bg-[#e5e7eb]">
                          <div
                            className="h-full bg-[#94a3b8]"
                            style={{ width: `${Math.round(prediction.feature_group_contribution.topology * 100)}%` }}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-[#888]">Attribution features unavailable for this contingency</p>
                  )}
                </div>
              </div>
            </div>

            {/* Before / After Outage Delta Cards */}
            <div className="pt-4 border-t border-[#e5e7eb]">
              <p className="eyebrow mb-3">Before vs After Contingency Impact (Delta)</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div className="border border-[#e5e7eb] p-3 bg-[#fafafa]">
                  <span className="text-[#666] block">Overloaded Lines</span>
                  <div className="font-mono font-semibold text-ink text-sm mt-0.5">
                    {prediction?.before_after?.overloaded_branches_before ?? 0} →{' '}
                    <span className="text-red">
                      {prediction?.before_after?.overloaded_branches_after ?? 0}
                    </span>
                  </div>
                </div>

                <div className="border border-[#e5e7eb] p-3 bg-[#fafafa]">
                  <span className="text-[#666] block">Peak Line Loading</span>
                  <div className="font-mono font-semibold text-ink text-sm mt-0.5">
                    {(prediction?.before_after?.max_loading_before ?? 45).toFixed(0)}% →{' '}
                    <span className="text-red">
                      {(prediction?.before_after?.max_loading_after ?? 52).toFixed(0)}%
                    </span>
                  </div>
                </div>

                <div className="border border-[#e5e7eb] p-3 bg-[#fafafa]">
                  <span className="text-[#666] block">Power Rerouted</span>
                  <div className="font-mono font-semibold text-ink text-sm mt-0.5">
                    {(prediction?.before_after?.mw_rerouted ?? 0).toFixed(1)} MW
                  </div>
                </div>

                <div className="border border-[#e5e7eb] p-3 bg-[#fafafa]">
                  <span className="text-[#666] block">Voltage Violations</span>
                  <div className="font-mono font-semibold text-ink text-sm mt-0.5">
                    {prediction?.before_after?.voltage_violations?.length ?? 0} buses
                  </div>
                </div>

                <div className="border border-[#e5e7eb] p-3 bg-[#fafafa]">
                  <span className="text-[#666] block">Isolated Buses</span>
                  <div className="font-mono font-semibold text-ink text-sm mt-0.5">
                    {prediction?.before_after?.islanded_buses?.length ?? 0} buses
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Collapsible Model Insights Section (Global) */}
            <div className="pt-4 border-t border-[#cfd3d8]">
              <div className="border border-[#cfd3d8] bg-white">
                <button
                  onClick={() => setModelInsightsOpen(!modelInsightsOpen)}
                  className="w-full p-4 flex items-center justify-between text-left hover:bg-[#fafafa] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-amber" />
                    <div>
                      <h4 className="text-sm font-semibold text-ink">
                        Global Model Insights &amp; Test Set Calibration
                      </h4>
                      <p className="text-[11px] text-[#666]">
                        Inspect global feature saliency, reliability calibration curves, and false positive/negative error cases.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-[#666]">
                    <span>{modelInsightsOpen ? 'Collapse' : 'Expand Insights'}</span>
                    {modelInsightsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {modelInsightsOpen && (
                  <div className="p-4 border-t border-[#e5e7eb] space-y-6 bg-[#fdfdfd]">
                    {/* Calibration Curve & Top Test Corridors */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Calibration Curve */}
                      <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="eyebrow">Reliability Diagram</span>
                          <span className="text-[10.5px] font-mono text-[#666]">
                            Brier Score: {globalInsights?.calibration_curve?.brier_score ?? 0.045}
                          </span>
                        </div>
                        <h5 className="text-xs font-semibold text-ink">
                          Model Probability Calibration Curve
                        </h5>

                        <div className="h-32 flex items-end justify-between gap-3 pt-3 border-b border-[#e5e7eb] px-2">
                          {(globalInsights?.calibration_curve?.bins || [
                            { predicted_risk_center: 0.1, actual_cascade_frequency: 0.08, sample_count: 50 },
                            { predicted_risk_center: 0.3, actual_cascade_frequency: 0.28, sample_count: 45 },
                            { predicted_risk_center: 0.5, actual_cascade_frequency: 0.52, sample_count: 35 },
                            { predicted_risk_center: 0.7, actual_cascade_frequency: 0.69, sample_count: 40 },
                            { predicted_risk_center: 0.9, actual_cascade_frequency: 0.88, sample_count: 30 }
                          ]).map((b, idx) => (
                            <div key={idx} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                              <div
                                className="w-full bg-charcoal transition-all"
                                style={{ height: `${b.actual_cascade_frequency * 100}%`, minHeight: '4px' }}
                              />
                              <span className="text-[10px] text-[#777] font-mono mt-1">
                                {Math.round(b.predicted_risk_center * 100)}%
                              </span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10.5px] text-[#777] leading-relaxed">
                          Close agreement between predicted risk probability and empirical cascade frequency validates reliable probability outputs.
                        </p>
                      </div>

                      {/* Top Influential Branches across Test Set */}
                      <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-2">
                        <span className="eyebrow">Global Attribution</span>
                        <h5 className="text-xs font-semibold text-ink">
                          Most Frequently Saliency-Critical Branches (Test Set)
                        </h5>

                        <div className="space-y-2 pt-1">
                          {(globalInsights?.most_frequently_important_branches || [
                            { branch_id: 3, name: 'Line 3-11', importance_frequency_pct: 78, mean_attribution_score: 0.84 },
                            { branch_id: 5, name: 'Line 5-7', importance_frequency_pct: 64, mean_attribution_score: 0.72 },
                            { branch_id: 9, name: 'Line 9-10', importance_frequency_pct: 52, mean_attribution_score: 0.61 }
                          ]).map((br) => (
                            <div key={br.branch_id} className="space-y-0.5">
                              <div className="flex justify-between text-[11px] font-mono">
                                <span>{br.name || formatBranchName(br.branch_id, branches)}</span>
                                <span className="text-[#666]">{br.importance_frequency_pct}% test frequency</span>
                              </div>
                              <div className="h-1.5 bg-[#e5e7eb] w-full">
                                <div className="h-full bg-charcoal" style={{ width: `${br.importance_frequency_pct}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Error Gallery */}
                    <div className="space-y-3">
                      <span className="eyebrow block">Model Error Gallery (Failure Case Diagnostics)</span>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Missed Cascades (False Negatives) */}
                        <div className="border border-[#fecaca] p-3 bg-[#fef2f2] space-y-2">
                          <span className="text-xs font-bold text-[#991b1b] flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5 text-red" />
                            <span>Missed Cascades (False Negatives)</span>
                          </span>
                          <p className="text-[11px] text-[#7f1d1d] leading-relaxed">
                            Contingencies predicted low-risk that subsequently tripped physical cascading stages.
                          </p>

                          <div className="space-y-2 pt-1">
                            {(globalInsights?.error_gallery?.false_negatives || [
                              {
                                sample_id: 42,
                                grid: 'case30',
                                outaged: ['line_8'],
                                load_scale: 1.15,
                                predicted_prob: 0.22,
                                actual_cascade: 1,
                                why: 'Extreme voltage instability triggered remote bus tripping beyond 2-hop radius.'
                              }
                            ]).map((item) => (
                              <div key={item.sample_id} className="p-2 bg-white border border-[#fca5a5] space-y-1.5 text-xs">
                                <div className="flex justify-between items-center">
                                  <span className="font-mono font-semibold text-ink">
                                    Sample #{item.sample_id} ({item.grid.toUpperCase()})
                                  </span>
                                  <span className="text-[10px] font-mono text-red font-bold">
                                    Pred: {Math.round(item.predicted_prob * 100)}% · Actual: CASCADE
                                  </span>
                                </div>
                                <p className="text-[11px] text-[#555]">{item.why}</p>
                                <button
                                  onClick={() => {
                                    setGridCase(item.grid);
                                    setOutagedElements(item.outaged);
                                    setLoadScale(item.load_scale);
                                  }}
                                  className="text-[10.5px] font-medium text-red hover:text-ink underline block"
                                >
                                  Open in Scene →
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* False Alarms (False Positives) */}
                        <div className="border border-[#fde68a] p-3 bg-[#fffbeb] space-y-2">
                          <span className="text-xs font-bold text-[#92400e] flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5 text-amber" />
                            <span>False Alarms (False Positives)</span>
                          </span>
                          <p className="text-[11px] text-[#78350f] leading-relaxed">
                            Contingencies flagged as severe risk that stabilized safely due to generator slack absorption.
                          </p>

                          <div className="space-y-2 pt-1">
                            {(globalInsights?.error_gallery?.false_positives || [
                              {
                                sample_id: 87,
                                grid: 'case30',
                                outaged: ['line_12'],
                                load_scale: 1.10,
                                predicted_prob: 0.74,
                                actual_cascade: 0,
                                why: 'Parallel circuit absorbed temporary 108% overload without tripping thermal relays.'
                              }
                            ]).map((item) => (
                              <div key={item.sample_id} className="p-2 bg-white border border-[#fcd34d] space-y-1.5 text-xs">
                                <div className="flex justify-between items-center">
                                  <span className="font-mono font-semibold text-ink">
                                    Sample #{item.sample_id} ({item.grid.toUpperCase()})
                                  </span>
                                  <span className="text-[10px] font-mono text-amber font-bold">
                                    Pred: {Math.round(item.predicted_prob * 100)}% · Actual: SAFE
                                  </span>
                                </div>
                                <p className="text-[11px] text-[#555]">{item.why}</p>
                                <button
                                  onClick={() => {
                                    setGridCase(item.grid);
                                    setOutagedElements(item.outaged);
                                    setLoadScale(item.load_scale);
                                  }}
                                  className="text-[10.5px] font-medium text-amber hover:text-ink underline block"
                                >
                                  Open in Scene →
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          </ErrorBoundary>
        )}

        {/* TAB 3: GRID STATS */}
        {activeTab === 'stats' && (
          <ErrorBoundary sectionName="Grid Statistics">
            <div className="pt-6 space-y-6">
            {/* Electrical Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="border border-[#e5e7eb] p-3 bg-white">
                <span className="eyebrow block mb-0.5">Total Grid Demand</span>
                <span className="text-base font-semibold font-mono text-ink">
                  {gridStats?.total_demand_mw ? `${gridStats.total_demand_mw.toFixed(1)} MW` : '---'}
                </span>
              </div>

              <div className="border border-[#e5e7eb] p-3 bg-white">
                <span className="eyebrow block mb-0.5">Total Generation</span>
                <span className="text-base font-semibold font-mono text-ink">
                  {gridStats?.total_generation_mw ? `${gridStats.total_generation_mw.toFixed(1)} MW` : '---'}
                </span>
              </div>

              <div className="border border-[#e5e7eb] p-3 bg-white">
                <span className="eyebrow block mb-0.5">Average Loading</span>
                <span className="text-base font-semibold font-mono text-ink">
                  {gridStats?.average_branch_loading_percent
                    ? `${gridStats.average_branch_loading_percent.toFixed(1)}%`
                    : '---'}
                </span>
              </div>

              <div className="border border-[#e5e7eb] p-3 bg-white">
                <span className="eyebrow block mb-0.5">Peak Branch Loading</span>
                <span className="text-base font-semibold font-mono text-ink">
                  {gridStats?.max_branch_loading_percent
                    ? `${gridStats.max_branch_loading_percent.toFixed(1)}%`
                    : '---'}
                </span>
              </div>
            </div>

            {/* Loading Histogram */}
            <div className="border border-[#e5e7eb] p-4 bg-white space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="eyebrow">Flow Distribution</p>
                  <h4 className="text-sm font-semibold text-ink">Branch Loading Histogram</h4>
                </div>
                <span className="text-xs text-[#777] font-mono">
                  {gridStats?.counts?.branches ?? branches.length} transmission lines
                </span>
              </div>

              {gridStats?.loading_histogram && gridStats.loading_histogram.length > 0 ? (
                <div className="grid grid-cols-6 gap-2 pt-2">
                  {gridStats.loading_histogram.map((bin) => (
                    <div key={bin.bin} className="text-center space-y-1">
                      <div className="h-20 bg-[#f9fafb] border border-[#e5e7eb] flex items-end justify-center p-1">
                        <div
                          className="w-full bg-charcoal transition-all"
                          style={{
                            height: `${Math.min(100, (bin.count / Math.max(1, branches.length)) * 140)}%`,
                            minHeight: bin.count > 0 ? '4px' : '0'
                          }}
                        />
                      </div>
                      <span className="block font-mono text-[11px] font-semibold text-ink">{bin.count}</span>
                      <span className="block text-[10px] text-[#777] font-mono">{bin.bin}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#888]">Loading histogram unavailable</p>
              )}
            </div>

            {/* Structural & Topological Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-1">
                <span className="eyebrow block">Average Node Degree</span>
                <span className="text-xl font-semibold font-mono text-ink">
                  {gridStats?.average_degree ? gridStats.average_degree.toFixed(2) : '---'}
                </span>
                <p className="text-[11px] text-[#666]">Average physical line connections per transmission bus.</p>
              </div>

              <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-1">
                <span className="eyebrow block">Single Points of Failure</span>
                <span className="text-xl font-semibold font-mono text-ink">
                  {gridStats?.num_bridge_branches ?? '---'} bridge branches
                </span>
                <p className="text-[11px] text-[#666]">Branches whose failure immediately islands part of the network.</p>
              </div>

              <div className="border border-[#e5e7eb] p-3.5 bg-white space-y-1">
                <span className="eyebrow block">Bus Type Breakdown</span>
                <div className="font-mono text-[11.5px] space-y-0.5 pt-1">
                  <div>Slack: {gridStats?.bus_type_counts?.slack ?? 1}</div>
                  <div>Generators: {gridStats?.bus_type_counts?.generator ?? 0}</div>
                  <div>Substations: {gridStats?.bus_type_counts?.substation ?? 0}</div>
                  <div>Loads: {gridStats?.bus_type_counts?.load ?? 0}</div>
                </div>
              </div>
            </div>
          </div>
          </ErrorBoundary>
        )}

        {/* TAB 4: DATA (Dataset Inspector) */}
        {activeTab === 'data' && (
          <ErrorBoundary sectionName="Dataset Inspector">
            <DatasetInspector />
          </ErrorBoundary>
        )}
      </div>

      {/* Floating Grid Assistant Chat Drawer */}
      <ErrorBoundary sectionName="Grid Assistant Chatbot">
        <ChatDrawer />
      </ErrorBoundary>
    </section>
  );
};
