'use client';

import { sparkGeometry } from '@/lib/spark';
import type { HistorySeries } from '@/lib/history/series';

/**
 * One window's trend over a shared time domain: value axis, time axis, reset
 * rules, honest gaps. Same geometry as the card sparkline, with axes — still
 * no chart library, still a few KB of SVG.
 */

export const CHART_W = 600;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;

interface Props {
  series: HistorySeries;
  from: number;
  to: number;
  /** Compact variant for narrow containers. */
  compact?: boolean;
}

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

/** Time-axis tick: dates once the window is more than half a day, else clock. */
function fmtTick(t: number, spanDays: number): string {
  if (spanDays > 2) return fmtDay(t);
  if (spanDays > 0.5) return `${new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${fmtClock(t)}`;
  return fmtClock(t);
}

/** Value label: percent rows read as %, money rows carry their unit. */
export function fmtChartValue(v: number, mode: string, unit: string | null): string {
  if (mode === 'absolute') {
    const n = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100;
    return `${unit ?? ''}${n}`;
  }
  return `${Math.round(v * 10) / 10}%`;
}

export default function TrendChart({ series, from, to, compact }: Props) {
  const points = series.points;
  if (points.length === 0) {
    return <div className="chart empty">No readings in this range yet.</div>;
  }
  const height = compact ? 80 : 120;
  const inner = height - PAD_TOP - PAD_BOTTOM;
  const geo = sparkGeometry(points, CHART_W, inner, { pad: 4, xDomain: [from, to] });
  const [lo, hi] = geo.yRange;
  const gridVals = hi === lo ? [hi] : [hi, (hi + lo) / 2, lo];
  const spanDays = (to - from) / 864e5;
  const latest = points[points.length - 1].v;
  // Data marks live in a translated group so the geometry stays a plain
  // 0..inner box; only the axis text needs absolute coordinates.
  const areaPaths = geo.segments
    .filter((s) => s.length > 1)
    .map((s) => `${s.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} L${s[s.length - 1].x},${inner} L${s[0].x},${inner} Z`);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${CHART_W} ${height}`}
        className="chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series.label} trend, ${geo.count} readings`}
      >
        {gridVals.map((v, i) => {
          const y = PAD_TOP + (hi === lo ? inner / 2 : (1 - (v - lo) / (hi - lo)) * inner);
          return (
            <g key={i}>
              <line
                x1={0}
                x2={CHART_W}
                y1={y}
                y2={y}
                className="chart-grid"
                vectorEffect="non-scaling-stroke"
              />
              <text x={3} y={y - 3} className="chart-axis" vectorEffect="non-scaling-stroke">
                {fmtChartValue(v, series.mode, series.unit)}
              </text>
            </g>
          );
        })}
        <g transform={`translate(0 ${PAD_TOP})`}>
          {areaPaths.map((d, i) => (
            <path key={`a${i}`} d={d} className="chart-area" />
          ))}
          {geo.resets.map((rx, i) => (
            <line
              key={`r${i}`}
              x1={rx}
              x2={rx}
              y1={0}
              y2={inner}
              className="chart-reset"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {geo.paths.map((d, i) => (
            <path key={i} d={d} className="chart-line" vectorEffect="non-scaling-stroke" />
          ))}
          {geo.end ? (
            <>
              <circle cx={geo.end.x} cy={geo.end.y} r={2.6} className="chart-end" />
              {/* Near the right edge the label would be clipped — flip it. */}
              <text
                x={geo.end.x > CHART_W - 46 ? geo.end.x - 6 : geo.end.x + 6}
                y={Math.max(9, geo.end.y - 5)}
                className={`chart-last${geo.end.x > CHART_W - 46 ? ' flip' : ''}`}
                vectorEffect="non-scaling-stroke"
              >
                {fmtChartValue(latest, series.mode, series.unit)}
              </text>
            </>
          ) : null}
        </g>
        <text x={2} y={height - 5} className="chart-axis" vectorEffect="non-scaling-stroke">
          {fmtTick(from, spanDays)}
        </text>
        <text
          x={CHART_W / 2}
          y={height - 5}
          className="chart-axis mid"
          vectorEffect="non-scaling-stroke"
        >
          {fmtTick((from + to) / 2, spanDays)}
        </text>
        <text
          x={CHART_W - 2}
          y={height - 5}
          className="chart-axis end"
          vectorEffect="non-scaling-stroke"
        >
          {fmtTick(to, spanDays)}
        </text>
      </svg>
    </div>
  );
}
