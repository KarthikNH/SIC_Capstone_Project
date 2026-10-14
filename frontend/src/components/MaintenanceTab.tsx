import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useGridStore, DEFAULT_24H_LOAD_PROFILE } from '../store';
import {
  Wrench,
  Download,
  Upload,
  Clock,
  ShieldAlert,
  Info,
  Calendar,
  Layers,
  CheckCircle2,
  AlertCircle,
  Search
} from 'lucide-react';

export const MaintenanceTab: React.FC = () => {
  const {
    gridCase,
    maintenanceData,
    loadingMaintenance,
    fetchMaintenancePriorities,
    maintenanceLoadProfile,
    setMaintenanceLoadProfile,
    selectedMaintenanceAsset,
    setSelectedMaintenanceAsset,
    plannedOutageResult,
    loadingPlannedOutage,
    evaluatePlannedOutage,
    uploadAssetCsv,
    showMaintenanceOverlay,
    toggleMaintenanceOverlay,
    toggleOutagedElement,
    outagedElements
  } = useGridStore();

  const [activeProfile, setActiveProfile] = useState<number[]>(maintenanceLoadProfile);
  const [profileModified, setProfileModified] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<'all' | 'Critical' | 'High' | 'Medium' | 'Low'>('all');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial load
  useEffect(() => {
    if (!maintenanceData || maintenanceData.grid_id !== gridCase) {
      fetchMaintenancePriorities(activeProfile);
    }
  }, [gridCase]);

  // Handle load profile slider adjust
  const handleHourProfileChange = (hourIndex: number, val: number) => {
    const updated = [...activeProfile];
    updated[hourIndex] = parseFloat(val.toFixed(2));
    setActiveProfile(updated);
    setProfileModified(true);
  };

  const handleApplyProfile = () => {
    setMaintenanceLoadProfile(activeProfile);
    setProfileModified(false);
    fetchMaintenancePriorities(activeProfile);
  };

  const handleResetProfile = () => {
    setActiveProfile(DEFAULT_24H_LOAD_PROFILE);
    setMaintenanceLoadProfile(DEFAULT_24H_LOAD_PROFILE);
    setProfileModified(false);
    fetchMaintenancePriorities(DEFAULT_24H_LOAD_PROFILE);
  };

  // Select asset for outage evaluation
  const handleSelectAsset = (assetId: string) => {
    setSelectedMaintenanceAsset(assetId);
    evaluatePlannedOutage(assetId, activeProfile);
  };

  // Filtered priority list
  const filteredPriorities = useMemo(() => {
    if (!maintenanceData?.priorities) return [];
    return maintenanceData.priorities.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
        item.asset_id.toLowerCase().includes(searchFilter.toLowerCase()) ||
        item.reason.toLowerCase().includes(searchFilter.toLowerCase());
      const matchesUrgency = urgencyFilter === 'all' || item.urgency === urgencyFilter;
      return matchesSearch && matchesUrgency;
    });
  }, [maintenanceData, searchFilter, urgencyFilter]);

  // Handle CSV upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const res = await uploadAssetCsv(file);
      setUploadSuccess(res.message || 'Asset data uploaded successfully.');
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload asset data.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="pt-6 space-y-8 text-ink">
      {/* Disclaimer Banner: MANDATORY */}
      <div className="p-3.5 bg-[#f8fafc] border border-[#cfd3d8] flex items-start gap-3 text-xs leading-relaxed">
        <Info className="w-4 h-4 text-charcoal shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-ink">Analytical Risk-Based Prioritisation: </span>
          <span className="text-[#555]">
            This module computes maintenance priority by combining empirical thermodynamic load stress with model-predicted cascade consequence (Priority = Likelihood &times; Consequence).
            This is <strong>not a learned Remaining-Useful-Life (RUL) prediction</strong> because historical physical failure event datasets are not available for this benchmark.
          </span>
        </div>
      </div>

      {/* Top Controls: Data Source Badge, Upload & Template, 3D Overlay Toggle */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-4 bg-white border border-[#cfd3d8]">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Asset Records:</span>
            <span
              className={`px-2.5 py-0.5 text-xs font-mono font-semibold border ${
                maintenanceData?.is_simulated_data
                  ? 'bg-amber/10 border-amber/40 text-amber'
                  : 'bg-emerald-50 border-emerald-400 text-emerald-800'
              }`}
            >
              {maintenanceData?.data_source_label || 'Simulated asset data'}
            </span>
          </div>
          {maintenanceData?.is_simulated_data && (
            <span className="text-[11px] text-[#666] font-mono">
              (Deterministic pseudo-random seed per grid topology)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Maintenance Overlay Toggle */}
          <button
            onClick={toggleMaintenanceOverlay}
            className={`px-3 py-1.5 text-xs font-medium border flex items-center gap-1.5 transition-all ${
              showMaintenanceOverlay
                ? 'bg-charcoal text-white border-charcoal shadow-2xs font-semibold'
                : 'bg-white text-ink border-[#cfd3d8] hover:border-charcoal'
            }`}
            title="Toggle priority color overlay across 3D, Map and City scenes"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Priority Scene Overlay {showMaintenanceOverlay ? '(ON)' : '(OFF)'}</span>
          </button>

          {/* Download CSV Template */}
          <a
            href="/maintenance/assets/template"
            download="asset_data_template.csv"
            className="px-3 py-1.5 text-xs font-medium bg-white text-[#444] border border-[#cfd3d8] hover:border-charcoal hover:text-ink flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>CSV Template</span>
          </a>

          {/* Upload CSV */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".csv"
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs font-medium bg-[#1a2332] text-white border border-[#1a2332] hover:bg-ink flex items-center gap-1.5 transition-colors shadow-2xs"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload Records</span>
          </button>
        </div>
      </div>

      {/* Upload Messages */}
      {uploadError && (
        <div className="p-3 bg-red/10 border border-red/30 text-xs text-red flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{uploadError}</span>
        </div>
      )}
      {uploadSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{uploadSuccess}</span>
        </div>
      )}

      {/* Section 1: 24-Hour Load Multiplier Profile */}
      <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-[#eee] pb-2">
          <div>
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              <Clock className="w-4 h-4 text-charcoal" />
              <span>24-Hour Operating Load Multiplier Curve</span>
            </h3>
            <p className="text-[11.5px] text-[#666]">
              Simulates daily load fluctuation (60% to 120%) to quantify thermal stress, peak loading, and outage risk windows.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {profileModified && (
              <button
                onClick={handleApplyProfile}
                className="px-3 py-1 bg-charcoal text-white text-xs font-semibold shadow-2xs hover:bg-ink transition-colors"
              >
                Apply &amp; Re-evaluate
              </button>
            )}
            <button
              onClick={handleResetProfile}
              className="px-2.5 py-1 text-xs text-[#666] hover:text-ink underline transition-colors"
            >
              Reset Default
            </button>
          </div>
        </div>

        {/* 24-Hour Bars / Sliders */}
        <div className="grid grid-cols-6 sm:grid-cols-12 md:grid-cols-24 gap-1.5 pt-2">
          {activeProfile.map((multiplier, hour) => {
            const pct = Math.round(multiplier * 100);
            const isHigh = pct >= 110;
            const isMed = pct >= 80 && pct < 110;
            return (
              <div key={hour} className="flex flex-col items-center gap-1 group">
                <span className="text-[9.5px] font-mono text-[#888]">{hour.toString().padStart(2, '0')}h</span>
                <div className="w-full bg-[#f0f4f8] h-20 rounded-none relative flex items-end p-0.5 border border-[#e5e7eb]">
                  <div
                    style={{ height: `${Math.max(10, ((multiplier - 0.5) / 0.8) * 100)}%` }}
                    className={`w-full transition-all ${
                      isHigh ? 'bg-red' : isMed ? 'bg-amber' : 'bg-emerald-600'
                    }`}
                  />
                </div>
                <input
                  type="range"
                  min="0.60"
                  max="1.25"
                  step="0.01"
                  value={multiplier}
                  onChange={(e) => handleHourProfileChange(hour, parseFloat(e.target.value))}
                  className="w-full h-1.5 accent-charcoal cursor-pointer"
                  title={`Hour ${hour}:00 - ${pct}% Load`}
                />
                <span className="text-[9.5px] font-mono font-semibold text-ink">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 2: Likelihood vs Consequence Risk Matrix & Planned Outage Timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Risk Matrix Plot */}
        <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
          <div className="flex items-center justify-between border-b border-[#eee] pb-2">
            <div>
              <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red" />
                <span>Risk Matrix (Likelihood vs Consequence)</span>
              </h3>
              <p className="text-[11px] text-[#666]">
                Click any point to select asset in the scene and plan maintenance outages.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[10.5px] font-mono">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#dc2626]" /> Critical</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#ea580c]" /> High</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#d97706]" /> Med</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#16a34a]" /> Low</span>
            </div>
          </div>

          {/* Scatter Chart Canvas Container */}
          <div className="relative w-full h-[280px] bg-[#fafbfc] border border-[#e5e7eb] p-4 select-none">
            {/* Quadrant Background Tints */}
            <div className="absolute inset-x-8 top-4 bottom-8 grid grid-cols-2 grid-rows-2 opacity-30 pointer-events-none">
              <div className="bg-amber-100/50 border-r border-b border-[#cfd3d8]" />
              <div className="bg-red-200/50 border-b border-[#cfd3d8]" />
              <div className="bg-emerald-100/50 border-r border-[#cfd3d8]" />
              <div className="bg-orange-100/50" />
            </div>

            {/* Quadrant Labels */}
            <div className="absolute top-5 right-10 text-[9.5px] font-mono font-bold text-red/60 uppercase">High Risk Zone</div>
            <div className="absolute bottom-10 left-10 text-[9.5px] font-mono font-bold text-emerald-800/60 uppercase">Nominal Zone</div>

            {/* Axes */}
            <div className="absolute left-8 bottom-8 top-4 w-[1px] bg-[#cfd3d8]" />
            <div className="absolute left-8 bottom-8 right-4 h-[1px] bg-[#cfd3d8]" />

            {/* Axis Titles */}
            <span className="absolute -rotate-90 left-0 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[#666] tracking-wider uppercase">
              Likelihood &rarr;
            </span>
            <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-mono text-[#666] tracking-wider uppercase">
              Cascade Consequence &rarr;
            </span>

            {/* Asset Scatter Dots */}
            {maintenanceData?.priorities.map((item) => {
              const xPos = `calc(32px + (100% - 48px) * ${item.consequence})`;
              const yPos = `calc(100% - 32px - (100% - 48px) * ${item.likelihood})`;
              const isSelected = selectedMaintenanceAsset === item.asset_id;

              return (
                <button
                  key={item.asset_id}
                  onClick={() => handleSelectAsset(item.asset_id)}
                  style={{ left: xPos, top: yPos }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-all group z-10 ${
                    isSelected
                      ? 'w-4 h-4 ring-2 ring-charcoal ring-offset-1 scale-125'
                      : 'w-2.5 h-2.5 hover:scale-150'
                  }`}
                  title={`${item.name} | Priority: ${item.priority_score} (Rank #${item.rank})`}
                >
                  <span
                    className="block w-full h-full rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {/* Tooltip on hover */}
                  <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-charcoal text-white text-[10px] font-mono rounded shadow-md whitespace-nowrap z-30 pointer-events-none">
                    <strong>{item.name}</strong> (#{item.rank})
                    <br />
                    L: {item.likelihood} &bull; C: {item.consequence} &bull; P: {item.priority_score}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="text-[11px] text-[#666] font-mono text-center">
            Formula: Likelihood L = 0.45(1 - condition) + 0.30 &times; min(1, age/40) + 0.25 &times; stress &bull; Priority P = L &times; C
          </div>
        </div>

        {/* Planned Outage Window Timeline */}
        <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
          <div className="flex items-center justify-between border-b border-[#eee] pb-2">
            <div>
              <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                <Calendar className="w-4 h-4 text-charcoal" />
                <span>Planned Outage Window Evaluation</span>
              </h3>
              <p className="text-[11px] text-[#666]">
                Simulates taking{' '}
                <strong className="text-ink">
                  {maintenanceData?.priorities.find((p) => p.asset_id === selectedMaintenanceAsset)?.name || selectedMaintenanceAsset || 'Selected Asset'}
                </strong>{' '}
                offline for maintenance across each hour.
              </p>
            </div>
            {plannedOutageResult?.verification && (
              <span className="px-2 py-0.5 text-[10px] font-mono font-semibold uppercase bg-emerald-50 text-emerald-800 border border-emerald-300">
                {plannedOutageResult.verification.label}
              </span>
            )}
          </div>

          {loadingPlannedOutage ? (
            <div className="h-[280px] flex items-center justify-center text-xs text-[#888] font-mono animate-pulse">
              Simulating 24-hour maintenance outage risk curve &amp; running cascade verification...
            </div>
          ) : plannedOutageResult ? (
            <div className="space-y-4">
              {/* Verdict Card */}
              <div className="p-3 bg-[#fafbfc] border-l-4 border-l-charcoal border border-[#e5e7eb] text-xs">
                <p className="font-semibold text-ink text-[12.5px] leading-snug">
                  {plannedOutageResult.verdict}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div className="p-1.5 bg-emerald-50 border border-emerald-200">
                    <span className="text-[#666] block">Safest Outage Window:</span>
                    <strong className="text-emerald-800 text-xs">
                      {plannedOutageResult.safest_window.label}
                    </strong>
                    <span className="text-[10px] text-emerald-700 block">
                      Avg Risk: {Math.round(plannedOutageResult.safest_window.average_risk * 100)}%
                    </span>
                  </div>
                  <div className="p-1.5 bg-red/10 border border-red/30">
                    <span className="text-[#666] block">Avoid Window:</span>
                    <strong className="text-red text-xs">
                      {plannedOutageResult.avoid_window.label}
                    </strong>
                    <span className="text-[10px] text-red block">
                      Peak Risk: {Math.round(plannedOutageResult.avoid_window.peak_risk * 100)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* 24-Hour Outage Risk Bar Chart */}
              <div>
                <span className="eyebrow block mb-1">Cascade Risk by Maintenance Start Hour:</span>
                <div className="grid grid-cols-12 md:grid-cols-24 gap-1 items-end h-28 bg-[#fafbfc] p-2 border border-[#e5e7eb]">
                  {plannedOutageResult.hourly_risks.map((h) => {
                    const riskPct = Math.round(h.cascade_risk * 100);
                    const isSafest =
                      h.hour >= plannedOutageResult.safest_window.start_hour &&
                      h.hour < plannedOutageResult.safest_window.end_hour;
                    const isAvoid =
                      h.hour >= plannedOutageResult.avoid_window.start_hour &&
                      h.hour < plannedOutageResult.avoid_window.end_hour;

                    return (
                      <div key={h.hour} className="flex flex-col items-center gap-0.5 group">
                        <div
                          style={{ height: `${Math.max(6, h.cascade_risk * 90)}px` }}
                          className={`w-full transition-all ${
                            isSafest
                              ? 'bg-emerald-600'
                              : isAvoid
                              ? 'bg-red'
                              : riskPct >= 50
                              ? 'bg-amber'
                              : 'bg-[#9aa3ad]'
                          }`}
                          title={`Hour ${h.time_label}: ${riskPct}% cascade risk`}
                        />
                        <span className="text-[8.5px] font-mono text-[#777]">{h.hour}h</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-xs text-[#888] font-mono">
              Select an asset from the table or matrix to evaluate its outage window.
            </div>
          )}
        </div>
      </div>

      {/* Section 3: Ranked Maintenance Priority Table */}
      <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-[#eee] pb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              <Wrench className="w-4 h-4 text-charcoal" />
              <span>Ranked Transmission Maintenance Priorities</span>
            </h3>
            <p className="text-[11.5px] text-[#666]">
              Assets sorted by risk priority score ($P = L \times C$). High and Critical assets require immediate inspection scheduling.
            </p>
          </div>

          {/* Filters & Search */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#888] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search asset, branch, or reason..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="pl-8 pr-3 py-1 text-xs border border-[#cfd3d8] bg-white text-ink placeholder:text-[#999] focus:outline-none focus:border-charcoal w-56"
              />
            </div>

            <div className="flex items-center gap-1 bg-[#f0f4f8] p-0.5 border border-[#cfd3d8] text-xs">
              {(['all', 'Critical', 'High', 'Medium', 'Low'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setUrgencyFilter(lvl)}
                  className={`px-2 py-0.5 font-medium transition-colors ${
                    urgencyFilter === lvl ? 'bg-charcoal text-white' : 'text-[#666] hover:text-ink'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Priority Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#f8fafc] border-b border-[#cfd3d8] text-[10.5px] font-mono uppercase text-[#666]">
                <th className="py-2 px-3">Rank</th>
                <th className="py-2 px-3">Asset</th>
                <th className="py-2 px-3">Urgency</th>
                <th className="py-2 px-3">Priority (P)</th>
                <th className="py-2 px-3">Likelihood (L)</th>
                <th className="py-2 px-3">Consequence (C)</th>
                <th className="py-2 px-3">Condition</th>
                <th className="py-2 px-3">Age</th>
                <th className="py-2 px-3">Stress (Peak / &gt;80h)</th>
                <th className="py-2 px-3">Last Inspected</th>
                <th className="py-2 px-3">Operational Reason</th>
                <th className="py-2 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eee]">
              {loadingMaintenance ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-xs text-[#888] font-mono animate-pulse">
                    Computing multi-asset thermodynamic stress curves and consequence screenings...
                  </td>
                </tr>
              ) : filteredPriorities.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-xs text-[#888]">
                    No maintenance records found matching the active filters.
                  </td>
                </tr>
              ) : (
                filteredPriorities.map((item) => {
                  const isSelected = selectedMaintenanceAsset === item.asset_id;
                  const isOutaged = outagedElements.includes(item.asset_id);

                  return (
                    <tr
                      key={item.asset_id}
                      onClick={() => handleSelectAsset(item.asset_id)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#f0f4f8] font-medium' : 'hover:bg-[#fafbfc]'
                      }`}
                    >
                      <td className="py-2.5 px-3 font-mono font-bold text-ink">#{item.rank}</td>
                      <td className="py-2.5 px-3 font-semibold text-ink whitespace-nowrap">
                        {item.name}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className="px-2 py-0.5 text-[10px] font-bold uppercase rounded-none"
                          style={{
                            backgroundColor: `${item.color}15`,
                            color: item.color,
                            border: `1px solid ${item.color}40`
                          }}
                        >
                          {item.urgency}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-bold" style={{ color: item.color }}>
                        {item.priority_score.toFixed(4)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#555]">{item.likelihood.toFixed(3)}</td>
                      <td className="py-2.5 px-3 font-mono text-[#555]">{item.consequence.toFixed(3)}</td>
                      <td className="py-2.5 px-3 font-mono">
                        <span className={item.condition_score < 0.4 ? 'text-red font-semibold' : 'text-ink'}>
                          {item.condition_score.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#555]">{item.age_years.toFixed(1)}y</td>
                      <td className="py-2.5 px-3 font-mono text-[#555] whitespace-nowrap">
                        {item.peak_loading_pct.toFixed(0)}% / {item.hours_above_80}h
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#777] whitespace-nowrap">
                        {item.last_inspection_date}
                      </td>
                      <td className="py-2.5 px-3 text-[11px] text-[#555] max-w-xs truncate" title={item.reason}>
                        {item.reason}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOutagedElement(item.asset_id);
                          }}
                          className={`px-2 py-0.5 text-[10.5px] border font-mono transition-colors ${
                            isOutaged
                              ? 'bg-red text-white border-red'
                              : 'bg-white border-[#cfd3d8] hover:border-red text-ink'
                          }`}
                        >
                          {isOutaged ? 'Restored' : 'Sim Outage'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
