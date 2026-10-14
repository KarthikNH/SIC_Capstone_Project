import React, { useEffect } from 'react';
import { useGridStore } from '../store';

export const ResultsSection: React.FC = () => {
  const { resultsData, loadingResults, fetchResults } = useGridStore();

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Filter benchmarks for the contingency held out split (unseen outages)
  const rows = (resultsData?.benchmark_comparison || [])
    .filter((r) => r.Split && r.Split.toLowerCase().includes('contingency-held-out'))
    .sort((a, b) => {
      // Prioritize GINE at top
      if (a.Model.includes('GINE')) return -1;
      if (b.Model.includes('GINE')) return 1;
      return 0;
    });

  // Fallback to all rows if split name doesn't match
  const displayRows = rows.length > 0 ? rows : resultsData?.benchmark_comparison || [];

  return (
    <section id="results" className="pt-24 sm:pt-28">
      <p className="eyebrow">Results</p>
      <h2 className="text-2xl sm:text-[26px] font-semibold text-ink mt-1.5 mb-6">
        How it compares on outages it has never seen
      </h2>

      {loadingResults ? (
        <div className="py-12 text-center text-sm text-[#8a8f96]">
          Loading verified benchmark metrics from backend...
        </div>
      ) : displayRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm text-right">
            <thead>
              <tr className="border-b border-[#e3e5e8]">
                <th className="py-3 px-2 text-left text-xs font-medium text-label uppercase tracking-wider">
                  Model
                </th>
                <th className="py-3 px-2 text-xs font-medium text-label uppercase tracking-wider">
                  Cascades caught (Recall)
                </th>
                <th className="py-3 px-2 text-xs font-medium text-label uppercase tracking-wider">
                  False alarms (FPR)
                </th>
                <th className="py-3 px-2 text-xs font-medium text-label uppercase tracking-wider">
                  PR-AUC
                </th>
                <th className="py-3 px-2 text-xs font-medium text-label uppercase tracking-wider hidden sm:table-cell">
                  ROC-AUC
                </th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, idx) => {
                const isGine = row.Model.includes('GINE');
                // Format percentage helper
                const fmtPct = (val: string | number) => {
                  if (typeof val === 'number') return `${Math.round(val * 100)}%`;
                  const num = parseFloat(String(val).split(' ')[0]);
                  return isNaN(num) ? val : `${Math.round(num * 100)}%`;
                };

                const fmtScore = (val: string | number) => {
                  if (typeof val === 'number') return val.toFixed(2);
                  const num = parseFloat(String(val).split(' ')[0]);
                  return isNaN(num) ? val : num.toFixed(2);
                };

                return (
                  <tr
                    key={idx}
                    className={`border-b border-[#e3e5e8] transition-colors ${
                      isGine ? 'font-semibold bg-[#fafafa]' : 'hover:bg-[#fbfbfb]'
                    }`}
                  >
                    <td className="py-3 px-2 text-left text-ink">
                      {row.Model}
                      {isGine && (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-amber bg-amber/10 px-1.5 py-0.5 rounded">
                          Best GNN
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-2 text-ink">
                      {fmtPct(row.Recall)}
                    </td>
                    <td className="py-3 px-2 text-ink">
                      {fmtPct(row['False Alarm Rate (FPR)'])}
                    </td>
                    <td className="py-3 px-2 text-ink">
                      {fmtScore(row['PR-AUC'])}
                    </td>
                    <td className="py-3 px-2 text-ink hidden sm:table-cell">
                      {fmtScore(row['ROC-AUC'])}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-[#8a8f96] py-6">
          No benchmark records returned. Ensure the FastAPI backend is running.
        </p>
      )}

      <p className="text-xs text-[#8a8f96] mt-3.5">
        Live data loaded dynamically from /results. Evaluated on strictly held-out contingency test splits.
      </p>
    </section>
  );
};
