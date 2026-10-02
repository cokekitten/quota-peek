'use client';

import { useMemo, useRef, useState } from 'react';
import { axisDecimals, nearestIndex, sparkGeometry, xExtent, yExtent } from '@/lib/spark';
import type { HistorySeries } from '@/lib/history/series';

/**
 * One window's trend: a line, a value axis that suits the row, and a crosshair
 * that reads out any point you hover.
 *
 * The scales are deliberately not "fit the data": a percentage meter is read
 * against 0, and a balance against its own magnitude (see lib/spark.ts) —
 * otherwise a 0.30 → 0.32 wobble renders as a mountain and the chart stops
 * meaning anything.
 */

export const CHART_W = 600;
export const CHART_H = 150;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
/** Left gutter so the value labels never sit on top of the line. */
const PAD_LEFT = 46;
const PAD_RIGHT = 10;

interface Props {
  series: HistorySeries;
  /** Requested range — used for the axis only when the data fills it. */
  from: number;
  to: number;
}

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Time, with the date only when it is not today. */
function fmtStamp(t: number, withSeconds = false): string {
  const d = new Date(t);
  const date = d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
  return d.toDateString() === new Date().toDateString() ? time : `${date} ${time}`;
}

/** Value label: percent rows read as %, money rows carry their unit. */
export function fmtChartValue(v: number, mode: string, unit: string | null, decimals = 1): string {
  const pow = (n: number) => Math.pow(10, n);
  if (mode === 'absolute') {
    const n = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * pow(decimals)) / pow(decimals);
    return `${unit ?? ''}${n.toLocaleString(undefined, { maximumFractionDigits: decimals })}`;
  }
  return `${Math.round(v * pow(decimals)) / pow(decimals)}%`;
}

export default function TrendChart({ series, from, to }: Props) {
  const points = series.points;
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const chart = useMemo(() => {
    if (points.length === 0) return null;
    const [x0, x1] = xExtent(points);
    // If the data does fill the requested window, honour the window's edges so
    // the labels line up with what the user asked for.
    const fill = (points[points.length - 1].t - points[0].t) / Math.max(1, to - from);
    const domain: [number, number] = fill > 0.8 ? [from, to] : [x0, x1];
    const values = points.map((p) => p.v);
    const [lo, hi] = yExtent(values, series.mode);
    const decimals = axisDecimals(hi - lo);
    const inner = CHART_H - PAD_TOP - PAD_BOTTOM;
    const geo = sparkGeometry(points, CHART_W - PAD_LEFT - PAD_RIGHT, inner, { pad: 4, xDomain: domain });
    const area = geo.segments
      .filter((sg) => sg.length > 1)
      .map(
        (sg) =>
          `${sg.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} L${sg[sg.length - 1].x},${inner} L${
            sg[0].x
          },${inner} Z`,
      );
    return { geo, area, lo, hi, decimals, inner, domain };
  }, [points, series.mode, from, to]);

  if (!chart) {
    return <div className="chart empty">No readings in this range yet.</div>;
  }

  const { geo, area, lo, hi, decimals, inner, domain } = chart;
  const gridVals = [hi, (hi + lo) / 2, lo];
  const yOf = (v: number) => {
    const span = hi - lo;
    return PAD_TOP + (span > 0 ? (1 - (v - lo) / span) * inner : inner / 2);
  };
  const spanMs = domain[1] - domain[0];
  const timeFmt = (t: number) => (spanMs > 2 * 864e5 ? new Date(t).toLocaleDateString() : fmtClock(t));
  const last = points[points.length - 1];

  // Hover: map the pointer into viewBox x, then snap to the nearest reading.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * CHART_W - PAD_LEFT;
    setHover(nearestIndex(geo.segments.flat(), x));
  };
  const flat = geo.segments.flat();
  const at = hover === null ? null : flat[hover];
  const prevAt = hover === null || hover === 0 ? null : flat[hover - 1];

  return (
    <div className="chart" ref={wrap}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series.label} trend, ${points.length} readings`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {gridVals.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT}
              x2={CHART_W - PAD_RIGHT}
              y1={yOf(v)}
              y2={yOf(v)}
              className="chart-grid"
              vectorEffect="non-scaling-stroke"
            />
            <text x={2} y={yOf(v) - 3} className="chart-axis" vectorEffect="non-scaling-stroke">
              {fmtChartValue(v, series.mode, series.unit, decimals)}
            </text>
          </g>
        ))}

        {/* Every data mark shares one origin: the line, the fill, the reset
            rules and the dots are drawn in the plot box, and the group shifts
            them into the gutter-free canvas in one step. */}
        <g transform={`translate(${PAD_LEFT} ${PAD_TOP})`}>
          {area.map((d, i) => (
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

          {/* Two or three readings can't make a line worth looking at — show the
              points themselves instead of a degenerate stroke. */}
          {points.length < 3 &&
            geo.segments.flat().map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2.4} className="chart-dot" />
            ))}

          {at && (
            <g className="chart-hover">
              <line
                x1={at.x}
                x2={at.x}
                y1={0}
                y2={inner}
                className="chart-crosshair"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={at.x} cy={at.y} r={3.4} className="chart-hover-dot" />
            </g>
          )}

          {geo.end && hover === null && (
            <>
              <circle cx={geo.end.x} cy={geo.end.y} r={2.6} className="chart-end" />
              <text
                x={geo.end.x > CHART_W - PAD_LEFT - 70 ? geo.end.x - 6 : geo.end.x + 6}
                y={Math.max(8, geo.end.y - 6)}
                className={`chart-last${geo.end.x > CHART_W - PAD_LEFT - 70 ? ' flip' : ''}`}
                vectorEffect="non-scaling-stroke"
              >
                {fmtChartValue(last.v, series.mode, series.unit, decimals)}
              </text>
            </>
          )}
        </g>

        <text x={2} y={CHART_H - 5} className="chart-axis" vectorEffect="non-scaling-stroke">
          {timeFmt(domain[0])}
        </text>
        <text x={CHART_W / 2} y={CHART_H - 5} className="chart-axis mid" vectorEffect="non-scaling-stroke">
          {timeFmt((domain[0] + domain[1]) / 2)}
        </text>
        <text x={CHART_W - 2} y={CHART_H - 5} className="chart-axis end" vectorEffect="non-scaling-stroke">
          {timeFmt(domain[1])}
        </text>
      </svg>

      {at && (
        <div
          className="chart-tip"
          style={{
            left: `${((at.x + PAD_LEFT) / CHART_W) * 100}%`,
            top: `${((at.y + PAD_TOP) / CHART_H) * 100}%`,
          }}
        >
          <b>{fmtStamp(at.t, true)}</b>
          <span>
            {fmtChartValue(at.v, series.mode, series.unit, decimals)}
            {prevAt && (
              <em className={at.v > prevAt.v ? 'up' : at.v < prevAt.v ? 'down' : 'flat'}>
                {at.v === prevAt.v ? '±0' : `${at.v > prevAt.v ? '+' : '−'}${fmtChartValue(
                  Math.abs(at.v - prevAt.v),
                  series.mode,
                  series.unit,
                  decimals,
                )}`}
              </em>
            )}
          </span>
          <small>
            reading {(hover ?? 0) + 1} of {points.length}
            {at.reset ? ' · window reset here' : ''}
            {at.br ? ' · after a gap' : ''}
          </small>
        </div>
      )}
    </div>
  );
}

