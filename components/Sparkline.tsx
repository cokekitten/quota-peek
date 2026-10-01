/**
 * Tiny hand-rolled sparkline (no chart library — the dashboard ships zero
 * runtime deps on purpose).
 *
 * Two behaviours matter for honesty rather than looks:
 *  - `br` (poller gap) splits the polyline instead of bridging it, so a
 *    stalled sampler can't look like a steep trend.
 *  - a window reset (`reset`) is a break too, with the reset drawn as a
 *    dotted vertical rule.
 *
 * The geometry is exported separately from the component: the card renders a
 * 100×20 sparkline, the history page renders the same shapes with axes.
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

export interface SparklineProps {
  points: readonly SparkPoint[];
  width?: number;
  height?: number;
  /** Stroke colour: a CSS var, so the theme toggle keeps working. */
  tone?: 'accent' | 'muted';
  title?: string;
  className?: string;
}

const TONE: Record<string, string> = {
  accent: 'var(--accent)',
  muted: 'var(--muted)',
};

export default function Sparkline({
  points,
  width = 100,
  height = 20,
  tone = 'accent',
  title,
  className,
}: SparklineProps) {
  const geo = sparkGeometry(points, width, height);
  if (geo.count === 0) return null;
  const stroke = TONE[tone] ?? TONE.accent;
  return (
    <svg
      className={className ? `spark ${className}` : 'spark'}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? 'usage trend'}
    >
      {title ? <title>{title}</title> : null}
      {geo.resets.map((rx, i) => (
        <line
          key={`r${i}`}
          x1={rx}
          x2={rx}
          y1={0}
          y2={height}
          className="spark-reset"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {geo.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {geo.end ? <circle cx={geo.end.x} cy={geo.end.y} r={1.4} fill={stroke} /> : null}
    </svg>
  );
}
