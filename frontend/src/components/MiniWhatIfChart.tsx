import React, { useMemo } from 'react';
import { useGridStore } from '../store';
import type { WhatIfPoint } from '../types';
import { CANONICAL_ALERT_THRESHOLD, formatPercent } from '../utils/probability';

export const MiniWhatIfChart: React.FC = () => {
  const { whatifCurve, loadingWhatif, loadScale, prediction } = useGridStore();

  const threshold = prediction?.alert_threshold ?? prediction?.operating_threshold ?? CANONICAL_ALERT_THRESHOLD;

  const points: WhatIfPoint[] = useMemo(() => {
    if (!whatifCurve) return [];
    return whatifCurve.points || (whatifCurve as any).curve_points || [];
  }, [whatifCurve]);

  const currentLoadPercent = Math.round(loadScale * 100);

  // SVG dimensions
  const width = 280;
  const height = 96;
  const padding = { top: 10, right: 12, bottom: 20, left: 28 };

  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const minX = 60;
  const maxX = 120;
  const minY = 0;
  const maxY = 1.0;

  const getX = (ls: number) => {
    const percent = ls * 100;
    return padding.left + ((percent - minX) / (maxX - minX)) * innerWidth;
  };

  const getY = (prob: number) => {
    return padding.top + innerHeight - ((prob - minY) / (maxY - minY)) * innerHeight;
  };

  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    return points
      .map((pt, idx) => {
        const x = getX(pt.load_scale);
        const y = getY(pt.cascade_probability ?? (pt as any).probability ?? 0);
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points]);

  const areaD = useMemo(() => {
    if (points.length === 0) return '';
    const firstX = getX(points[0].load_scale);
    const lastX = getX(points[points.length - 1].load_scale);
    const baseY = getY(0);
    return `${pathD} L ${lastX.toFixed(1)} ${baseY.toFixed(1)} L ${firstX.toFixed(1)} ${baseY.toFixed(1)} Z`;
  }, [pathD, points]);

  // Current interpolated marker
  const currentY = useMemo(() => {
    if (points.length === 0) return getY(0);
    const closest = points.reduce((prev, curr) => {
      return Math.abs(curr.load_scale * 100 - currentLoadPercent) <
        Math.abs(prev.load_scale * 100 - currentLoadPercent)
        ? curr
        : prev;
    }, points[0]);
    return getY(closest.cascade_probability ?? (closest as any).probability ?? 0);
  }, [points, currentLoadPercent]);

  const currentX = getX(loadScale);

  return (
    <div className="bg-white border border-[#e5e7eb] p-3 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="eyebrow">Risk Trajectory (What-If)</span>
        <span className="font-mono text-[10.5px] text-[#777]">
          {loadingWhatif ? 'Computing...' : '60% → 120% Load'}
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-24 overflow-visible"
          aria-label="What-If Risk Trajectory Curve"
        >
          {/* Canonical threshold line (dashed red/amber) */}
          <line
            x1={padding.left}
            y1={getY(threshold)}
            x2={width - padding.right}
            y2={getY(threshold)}
            stroke="#f59e0b"
            strokeDasharray="3 3"
            strokeWidth="1.2"
          />
          <line
            x1={padding.left}
            y1={getY(0)}
            x2={width - padding.right}
            y2={getY(0)}
            stroke="#d1d5db"
          />

          {/* Y Axis labels */}
          <text
            x={padding.left - 4}
            y={getY(1.0) + 4}
            fontSize="8.5"
            textAnchor="end"
            fill="#888"
            fontFamily="monospace"
          >
            1.0
          </text>
          <text
            x={padding.left - 4}
            y={getY(threshold) + 3}
            fontSize="8.5"
            textAnchor="end"
            fill="#f59e0b"
            fontFamily="monospace"
            fontWeight="bold"
          >
            {threshold.toFixed(2)}
          </text>
          <text
            x={padding.left - 4}
            y={getY(0) + 2}
            fontSize="8.5"
            textAnchor="end"
            fill="#888"
            fontFamily="monospace"
          >
            0.0
          </text>

          {/* Area fill */}
          {areaD && <path d={areaD} fill="#f0f4f8" opacity="0.8" />}

          {/* Main Risk trajectory curve */}
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke="#2b2b2b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Synced marker at current slider loadScale */}
          <g transform={`translate(${currentX}, ${currentY})`}>
            <circle r="4.5" fill="#c8443b" stroke="#ffffff" strokeWidth="1.5" />
            <circle r="7" fill="none" stroke="#c8443b" strokeWidth="1" opacity="0.4" />
          </g>

          {/* X Axis labels */}
          <text
            x={getX(0.6)}
            y={height - 4}
            fontSize="8.5"
            textAnchor="middle"
            fill="#888"
            fontFamily="monospace"
          >
            60%
          </text>
          <text
            x={getX(1.0)}
            y={height - 4}
            fontSize="8.5"
            textAnchor="middle"
            fill="#888"
            fontFamily="monospace"
          >
            100%
          </text>
          <text
            x={getX(1.2)}
            y={height - 4}
            fontSize="8.5"
            textAnchor="middle"
            fill="#888"
            fontFamily="monospace"
          >
            120%
          </text>
        </svg>

        {/* Operating threshold legend note */}
        <div className="flex items-center justify-between text-[10px] text-[#666] pt-1 border-t border-[#f0f0f0]">
          <span className="flex items-center gap-1 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-red inline-block" /> Active Operating Point ({currentLoadPercent}%)
          </span>
          <span className="font-mono text-amber font-semibold">
            Alert Threshold: {formatPercent(threshold * 100, 0)}
          </span>
        </div>
      </div>
    </div>
  );
};
