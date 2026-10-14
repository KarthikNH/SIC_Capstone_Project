import React from 'react';
import { useGridStore } from '../store';
import { Sparkles, CheckCircle2, RotateCcw, AlertTriangle, ShieldCheck, ArrowRight, Play } from 'lucide-react';
import { formatPercent } from '../utils/probability';

export const SuggestedFixCard: React.FC = () => {
  const {
    suggestedFix,
    loadingSuggestedFix,
    appliedFix,
    applyFix,
    undoFix,
    verifyFixInSimulator,
    verifiedFixResult,
    loadingReplay
  } = useGridStore();

  if (loadingSuggestedFix) {
    return (
      <div className="p-3.5 border border-[#e5e7eb] bg-[#fbfbfb] space-y-2 animate-pulse text-xs">
        <div className="flex items-center justify-between">
          <div className="h-4 bg-[#e5e7eb] w-32 rounded" />
          <div className="h-4 bg-[#e5e7eb] w-20 rounded" />
        </div>
        <div className="h-8 bg-[#e5e7eb] w-full rounded" />
      </div>
    );
  }

  if (!suggestedFix) {
    return null;
  }

  const isApplied = Boolean(appliedFix);

  return (
    <div className="p-4 border border-[#cfd3d8] bg-white space-y-3.5 shadow-xs">
      {/* Header with Title and Verification Source Label */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0f0f0] pb-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber" />
          <span className="eyebrow text-charcoal">Suggested Counterfactual Fix</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] font-mono font-semibold px-2 py-0.5 border ${
              suggestedFix.label === 'simulator verified'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                : 'bg-blue-50 text-blue-800 border-blue-300'
            }`}
          >
            {suggestedFix.label}
          </span>
          {suggestedFix.disagreement_resolved && (
            <span className="text-[10px] font-mono px-2 py-0.5 bg-purple-50 text-purple-800 border border-purple-200">
              simulator search
            </span>
          )}
        </div>
      </div>

      {/* Plain Language Action Description */}
      <p className="text-xs text-ink font-sans leading-relaxed font-medium">
        {suggestedFix.plain_text}
      </p>

      {/* Action Type and Before/After Metric Badges */}
      {suggestedFix.before_numbers && suggestedFix.after_numbers && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div className="bg-[#f9fafb] p-2 border border-[#e5e7eb]">
            <span className="text-[#666] block text-[10.5px]">Intervention Type</span>
            <span className="font-mono font-bold text-ink text-xs capitalize">
              {suggestedFix.action_type.replace('_', ' ')}
            </span>
          </div>

          {typeof suggestedFix.before_numbers.load_pct === 'number' && typeof suggestedFix.after_numbers.load_pct === 'number' && (
            <div className="bg-[#f9fafb] p-2 border border-[#e5e7eb]">
              <span className="text-[#666] block text-[10.5px]">System Load Scale</span>
              <span className="font-mono font-bold text-ink text-xs flex items-center gap-1">
                {suggestedFix.before_numbers.load_pct}% <ArrowRight className="w-3 h-3 text-[#888]" /> {suggestedFix.after_numbers.load_pct}%
              </span>
            </div>
          )}

          {typeof suggestedFix.before_numbers.risk === 'number' && typeof suggestedFix.after_numbers.risk === 'number' && (
            <div className="bg-[#f9fafb] p-2 border border-[#e5e7eb]">
              <span className="text-[#666] block text-[10.5px]">Cascade Probability</span>
              <span className="font-mono font-bold text-ink text-xs flex items-center gap-1">
                {formatPercent(suggestedFix.before_numbers.risk * 100)} <ArrowRight className="w-3 h-3 text-[#888]" /> {formatPercent(suggestedFix.after_numbers.risk * 100)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* If No Single Action Succeeded, list next best options */}
      {!suggestedFix.success && suggestedFix.next_best_options && suggestedFix.next_best_options.length > 0 && (
        <div className="p-3 bg-amber-50/60 border border-amber-200 text-xs space-y-2">
          <div className="flex items-center gap-1.5 text-amber-800 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Next Best Multi-Step Options:</span>
          </div>
          <div className="space-y-1.5 pl-5 list-disc text-[#666]">
            {suggestedFix.next_best_options.map((opt, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2">
                <span>
                  <strong>{opt.title}:</strong> {opt.plain_text}
                </span>
                {opt.action && (
                  <button
                    onClick={() => applyFix({ ...suggestedFix, action: opt.action, title: opt.title, plain_text: opt.plain_text, success: true })}
                    className="px-2 py-0.5 text-[11px] font-mono border border-charcoal bg-white hover:bg-charcoal hover:text-white"
                  >
                    Apply
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons & Banner */}
      <div className="pt-2 border-t border-[#f0f0f0] space-y-2.5">
        {!isApplied && suggestedFix.success && (
          <button
            onClick={() => applyFix(suggestedFix)}
            className="btn-estate-dark w-full py-2 text-xs flex items-center justify-center gap-2 shadow-2xs"
          >
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Apply Counterfactual Fix</span>
          </button>
        )}

        {isApplied && (
          <div className="space-y-2">
            <div className="p-2.5 bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-2 text-xs text-emerald-900 font-medium">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Fix applied: operating point updated to {appliedFix?.title || 'suggested intervention'}.</span>
              </span>
              <button
                onClick={undoFix}
                className="px-2 py-1 bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100 flex items-center gap-1 font-mono text-[11px]"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Undo</span>
              </button>
            </div>

            <button
              onClick={verifyFixInSimulator}
              disabled={loadingReplay}
              className="w-full py-2 bg-charcoal text-white hover:bg-ink text-xs font-semibold flex items-center justify-center gap-2 transition-colors border border-charcoal shadow-2xs"
            >
              {loadingReplay ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  <span>Verifying in Quasi-Dynamic Simulator...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Re-run simulation to verify</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Verification Before vs After Comparison */}
        {verifiedFixResult && (
          <div className="p-3 border border-emerald-200 bg-emerald-50/50 space-y-1.5 text-xs text-ink">
            <span className="eyebrow block text-emerald-800">Simulator Verification Result</span>
            <div className="space-y-1 font-mono text-[11.5px]">
              <div className="text-red/90">{verifiedFixResult.before}</div>
              <div className="text-emerald-700 font-bold flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>{verifiedFixResult.after}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
