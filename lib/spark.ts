/**
 * Trend geometry for the history charts — pure, no chart library (the project
 * ships zero runtime deps on purpose).
 *
 * Two behaviours matter for honesty rather than looks:
 *  - `br` (poller gap) splits the polyline instead of bridging it, so a
 *    stalled sampler can't look like a steep trend.
 *  - a window reset (`reset`) is a break too, with the reset drawn as a
 *    dotted vertical rule.
 *
 * <TrendChart> renders these segments with axes; the dashboard cards render no
 * chart at all — they only carry the change badge, which stays readable at a
 * glance while a trend line does not.
 */

export interface SparkPoint {
  t: number;
  v: number;
  /** Start a new segment. */
  br?: number;
  /** This point is the first after a window reset. */
  reset?: number;
}

/** One plotted point, in viewBox coordinates. */
export interface SparkSegPoint {
  t: number;
  v: number;
  x: number;
  y: number;
  reset?: 1;
  /** This point starts a new segment (a gap in sampling). */
  br?: 1;
}

export interface SparkGeometry {
  /** Contiguous runs — one polyline each; more than one means a gap. */
  segments: SparkSegPoint[][];
  /** Ready-to-use `d` attributes (one per segment). */
  paths: string[];
  /** x positions where a window reset happened. */
  resets: number[];
  /** Last point, for the end dot. */
  end?: { x: number; y: number };
  /** Vertical value range actually used (for axis labels). */
  yRange: [number, number];
  count: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface SparkGeometryOptions {
  /** Inset so the line never touches the viewBox edge. */
  pad?: number;
  /** Force the time domain (e.g. to align several charts on one window). */
  xDomain?: [number, number];
}

/**
 * Map points into a viewBox. A flat series is drawn down the middle rather
 * than pinned to an edge, and a single point becomes a dot.
 */
export function sparkGeometry(
  points: readonly SparkPoint[],
  width = 100,
  height = 20,
  { pad = 1.5, xDomain }: SparkGeometryOptions = {},
): SparkGeometry {
  const usable = points.filter((p) => Number.isFinite(p.v));
  if (usable.length === 0) return { segments: [], paths: [], resets: [], yRange: [0, 0], count: 0 };
  const vs = usable.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min;
  const t0 = xDomain ? xDomain[0] : usable[0].t;
  const tSpan = (xDomain ? xDomain[1] : usable[usable.length - 1].t) - t0;
  const innerH = height - pad * 2;
  const x = (t: number) => (tSpan > 0 ? ((t - t0) / tSpan) * width : width / 2);
  const y = (v: number) => (span > 0 ? pad + (1 - (v - min) / span) * innerH : height / 2);

  const segments: SparkSegPoint[][] = [];
  const resets: number[] = [];
  let seg: SparkSegPoint[] = [];
  for (const p of usable) {
    if (p.br && seg.length) {
      segments.push(seg);
      seg = [];
    }
    const pt: SparkSegPoint = { t: p.t, v: p.v, x: round(x(p.t)), y: round(y(p.v)) };
    if (p.br) pt.br = 1;
    if (p.reset) {
      pt.reset = 1;
      resets.push(pt.x);
    }
    seg.push(pt);
  }
  if (seg.length) segments.push(seg);

  const paths = segments.map((s) =>
    // A lone point becomes a dot: a zero-length line with a stub tail.
    s.length === 1 ? `M${s[0].x},${s[0].y} l0.01,0` : s.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '),
  );
  const last = usable[usable.length - 1];
  return {
    segments,
    paths,
    resets,
    end: { x: round(x(last.t)), y: round(y(last.v)) },
    yRange: [min, max],
    count: usable.length,
  };
}

/* ------------------------------------------------------------------ *
 * Chart scales
 *
 * Two mistakes make a line chart look like an abstract shape, and both
 * were made here:
 *
 *  - **X locked to the requested window.** Asking for 7 days while the data
 *    covers 10 hours squeezes the whole line into the right 6% of the canvas;
 *    the rest is empty space. A chart should span the data it has.
 *  - **Y auto-zoomed to the data.** 0.30 → 0.32 becomes a mountain, and 1%
 *    → 3% looks like a cliff. A meter's percentages are read against 0–100 and
 *    a balance against its own magnitude, so the scale follows the kind of row.
 * ------------------------------------------------------------------ */

/** Time span to draw: the data's own extent, padded so the ends aren't on the edge. */
export function xExtent(points: readonly SparkPoint[], padRatio = 0.02): [number, number] {
  if (points.length === 0) return [0, 0];
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  if (t1 <= t0) return [t0 - 30_000, t1 + 30_000];
  const pad = (t1 - t0) * padRatio;
  return [t0 - pad, t1 + pad];
}

/**
 * Value span to draw.
 *
 *  - percentage rows are meter readings: anchored at 0 so a 1%→3% move looks
 *    like what it is, with a 10% floor so a nearly-idle row is not pinned to
 *    the very bottom of the canvas;
 *  - money rows keep their own magnitude (a ¥1587 balance dropping to ¥1580
 *    should read as a gentle decline, not a 0-to-1587 flat line), but never
 *    zoom tighter than 1.2% of the value — below that the line is noise and
 *    the honest picture is a flat one.
 */
export function yExtent(values: readonly number[], mode: 'percent' | 'absolute'): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (mode === 'percent') {
    return [Math.min(0, min), Math.max(10, max * 1.1)];
  }
  if (max <= 0) return [min * 1.1 - 0.5, 0];
  // Small numbers against a much larger pool (spend inside a balance): anchor
  // at zero so the share is readable.
  if (min <= max * 0.25) return [0, max * 1.1];
  const span = Math.max(max - min, max * 0.012);
  const mid = (max + min) / 2;
  return [Math.max(0, mid - span / 2 - span * 0.12), mid + span / 2 + span * 0.12];
}

/** Decimals that suit the span being drawn, so an axis reads ¥0.30 not ¥0.3. */
export function axisDecimals(span: number): number {
  const s = Math.abs(span);
  if (s >= 100) return 0;
  if (s >= 10) return 1;
  if (s >= 1) return 2;
  return 3;
}

/** Index of the reading nearest a pointer x (viewBox coordinates). */
export function nearestIndex(points: readonly { x: number }[], x: number): number {
  if (points.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(points[0].x - x);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].x - x);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}
