/**
 * Turn stored row points into chart-ready series.
 *
 * Two rules matter more than the maths:
 *
 *  1. **A window rollover is not a consumption drop.** A 5h window at 98% that
 *     resets reports 0% next round; a naive difference says "-98%" and lies.
 *     When the row's own reset clock jumps (by more than a few minutes — some
 *     providers recompute it, so small wobble is not a new window) the delta
 *     is suppressed and the point is flagged so the chart breaks the line.
 *  2. **A gap is a gap.** If the poller stalled (machine asleep, container
 *     down) the points are not connected, otherwise the chart invents a slope
 *     that never happened.
 *
 * The geometry below is pure — points in, series out — so the tricky part is
 * testable without a database. The two `build*History` helpers wrap it with
 * the queries the API routes need.
 */

import { MERGED, type StoredRow, type StoredSample } from './db';
import { fetchAll, pointsInRange, samplesInRange } from './store';

export type SeriesMode = 'percent' | 'absolute';

/**
 * Rows that report an absolute figure are money/counter rows, not windows.
 * Their `percent` is either absent or a meaningless placeholder (a Balance has
 * no quota, so providers report 0) — plotting it would draw a flat line at
 * zero, so these rows are charted and read in their own unit.
 */
const ABSOLUTE_KINDS = new Set(['balance', 'spend', 'credits', 'money']);

/** How a row of this kind is charted and read. */
export function rowMode(kind: string): SeriesMode {
  return ABSOLUTE_KINDS.has(baseKind(kind)) ? 'absolute' : 'percent';
}

export function seriesKey(scope: string, kind: string): string {
  return `${scope}:${kind}`;
}

/** A window kind without its model suffix (Claude's `weekly_fable` → `weekly`). */
export function baseKind(kind: string): string {
  const i = kind.indexOf('_');
  return i > 0 ? kind.slice(0, i) : kind;
}

export interface HistoryPoint {
  t: number;
  v: number;
  /** Start a new polyline segment (poller gap). */
  br?: 1;
  /** The window reset at/just before this point — delta suppressed, line broken. */
  reset?: 1;
}

export type HistoryDelta =
  /** Percentage points between the last two readings. */
  | { kind: 'pp'; value: number; at: number; gapMs: number }
  /** Absolute difference (money / counters) between the last two readings. */
  | { kind: 'abs'; value: number; at: number; gapMs: number; unit: string | null }
  /** The window rolled over: no delta, by design. */
  | { kind: 'reset'; at: number };

export interface HistorySeries {
  key: string;
  provider: string;
  scope: string;
  kind: string;
  label: string;
  mode: SeriesMode;
  unit: string | null;
  points: HistoryPoint[];
  last?: { v: number; at: number; u?: number | null; n?: number | null };
  delta: HistoryDelta | null;
  /** The row is itself a cross-account estimate (mixed/unknown plans). */
  estimated: boolean;
  /** Newest reading is older than a healthy poll cycle — the poller stalled. */
  stale: boolean;
}

export interface HistoryLogRow {
  scope: string;
  kind: string;
  label: string;
  v: number | null;
  u: number | null;
  n: number | null;
  unit: string | null;
}

/** One fetch = one row in the "what did each refresh see" table. */
export interface HistoryLogEntry {
  id: number;
  ts: number;
  source: string;
  ok: boolean;
  errKind: string | null;
  errText: string | null;
  planLabel: string | null;
  partial: boolean;
  stale: boolean;
  rows: HistoryLogRow[];
}

export interface ProviderHistory {
  provider: string;
  from: number;
  to: number;
  series: HistorySeries[];
  log: HistoryLogEntry[];
  samples: number;
}

const MIN_INTERVAL_MS = 60_000;

export function pollIntervalMs(): number {
  const n = Number(process.env.QP_POLL_INTERVAL_MS);
  return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? n : 5 * 60_000;
}

/** Points further apart than this are a stall, not a trend. */
export function gapMs(intervalMs: number = pollIntervalMs()): number {
  return Math.max(3 * intervalMs, 10 * 60_000);
}

export function parseRange(range: string | null | undefined): number {
  const m = /^(\d+)\s*([hd])$/i.exec((range ?? '').trim());
  if (!m) return 7 * 864e5;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return 7 * 864e5;
  return n * (unit === 'h' ? 3600e3 : 864e5);
}

/**
 * How far a window's reset clock may drift before we call it a new window.
 *
 * Some providers recompute "resets at" from the current time, so the value
 * wobbles by seconds between samples. Comparing reset times exactly would
 * then suppress every delta forever. A real rollover moves the clock by a
 * whole window (5h, 7d, 30d) — far above this tolerance.
 */
const RESET_TOLERANCE_MS = 5 * 60_000;

/** True when the row is a different window instance than the previous reading. */
export function isRollover(prevResetAt: number | null, resetAt: number | null): boolean {
  if (prevResetAt === null || resetAt === null) return false;
  return Math.abs(resetAt - prevResetAt) > RESET_TOLERANCE_MS;
}

interface RawPoint {
  t: number;
  percent: number | null;
  used: number | null;
  total: number | null;
  unit: string | null;
  resetAt: number | null;
  /** Roll-over edge: this point's window clock differs from the previous one. */
  rollover: boolean;
}

/**
 * The number a row is charted and compared by.
 *  - window rows: the reported percentage, or used/total when there isn't one;
 *  - money/counter rows: the absolute figure itself (¥ spent, balance left).
 */
export function pointValue(
  p: { percent: number | null; used: number | null; total: number | null },
  mode: SeriesMode,
): number | null {
  if (mode === 'absolute') {
    if (p.used !== null) return p.used;
    return p.percent;
  }
  if (p.percent !== null) return p.percent;
  if (p.used !== null && p.total !== null && p.total > 0) return (p.used / p.total) * 100;
  return null;
}

const valueOf = (r: StoredRow, mode: SeriesMode) => pointValue(r, mode);

function toRawPoints(rows: readonly StoredRow[]): RawPoint[] {
  const out: RawPoint[] = [];
  let prevReset: number | null | undefined;
  for (const r of rows) {
    const rollover = prevReset !== undefined && isRollover(prevReset, r.resetAt);
    out.push({
      t: r.ts,
      percent: r.percent,
      used: r.used,
      total: r.total,
      unit: r.unit,
      resetAt: r.resetAt,
      rollover,
    });
    prevReset = r.resetAt;
  }
  return out;
}

/**
 * Downsample to at most `maxPoints` by averaging snapshot values inside each
 * time bucket (last value for counters, which are cumulative). Empty buckets
 * are dropped, which is what produces a visible gap instead of a straight line.
 */
function bucketize(points: RawPoint[], maxPoints: number, mode: SeriesMode): HistoryPoint[] {
  const withValue = points.filter((p) => pointValue(p, mode) !== null);
  if (withValue.length === 0) return [];
  const flag = (p: RawPoint): { reset?: 1 } => (p.rollover ? { reset: 1 as const } : {});
  if (withValue.length <= maxPoints || maxPoints < 2) {
    return withValue.map((p) => ({ t: p.t, v: pointValue(p, mode) as number, ...flag(p) }));
  }
  const from = withValue[0].t;
  const to = withValue[withValue.length - 1].t;
  // +1 keeps the bucket count ≤ maxPoints (indices run 0..floor(span/size)).
  const size = Math.max(1, Math.ceil((to - from + 1) / maxPoints));
  const buckets: { t: number; vs: number[]; last: RawPoint }[] = [];
  for (const p of withValue) {
    const idx = Math.floor((p.t - from) / size);
    const b = buckets[idx];
    if (!b) buckets.push({ t: p.t, vs: [pointValue(p, mode) as number], last: p });
    else {
      b.vs.push(pointValue(p, mode) as number);
      b.last = p;
    }
  }
  return buckets.map((b) => ({
    t: b.t,
    v: mode === 'absolute' ? (pointValue(b.last, mode) as number) : b.vs.reduce((a, c) => a + c, 0) / b.vs.length,
    ...flag(b.last),
  }));
}

function computeDelta(points: readonly StoredRow[], mode: SeriesMode): HistoryDelta | null {
  if (points.length < 2) return null;
  const cur = points[points.length - 1];
  const prev = points[points.length - 2];
  // Same window clock on both sides means the difference is real consumption.
  if (isRollover(prev.resetAt, cur.resetAt)) {
    return { kind: 'reset', at: prev.ts };
  }
  const gap = cur.ts - prev.ts;
  if (mode === 'absolute') {
    if (cur.used === null || prev.used === null) return null;
    return { kind: 'abs', value: cur.used - prev.used, at: prev.ts, gapMs: gap, unit: cur.unit };
  }
  const cv = valueOf(cur, mode);
  const pv = valueOf(prev, mode);
  if (cv === null || pv === null) return null;
  return { kind: 'pp', value: cv - pv, at: prev.ts, gapMs: gap };
}

export interface BuildSeriesOptions {
  provider: string;
  points: readonly StoredRow[];
  maxPoints?: number;
  intervalMs?: number;
  now?: number;
  /** Range end, used to tell "history" from "the poller stalled". */
  to?: number;
}

export function buildSeries({
  provider,
  points,
  maxPoints = 400,
  intervalMs = pollIntervalMs(),
  now = Date.now(),
  to = now,
}: BuildSeriesOptions): HistorySeries[] {
  const groups = new Map<string, StoredRow[]>();
  for (const p of points) {
    const key = seriesKey(p.scope, p.kind);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const limit = gapMs(intervalMs);
  const series: HistorySeries[] = [];
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.ts - b.ts);
    const kind = rows[0].kind;
    // Fall back to absolute when a window kind never reported a percentage.
    const mode: SeriesMode = rowMode(kind) === 'absolute' || rows.every((r) => r.percent === null)
      ? 'absolute'
      : 'percent';
    const raw = toRawPoints(rows);
    const plist = bucketize(raw, maxPoints, mode);
    // Gaps are decided on the plotted points so downsampling can't fake one.
    for (let i = 1; i < plist.length; i++) {
      if (plist[i].t - plist[i - 1].t > limit) plist[i].br = 1;
    }
    const lastRow = rows[rows.length - 1];
    const lastV = pointValue(raw[raw.length - 1], mode);
    series.push({
      key,
      provider,
      scope: rows[0].scope,
      kind,
      label: rows[0].label || kind,
      mode,
      unit: rows[0].unit,
      points: plist,
      last:
        lastV === null
          ? undefined
          : { v: lastV, at: lastRow.ts, u: lastRow.used, n: lastRow.total },
      delta: computeDelta(rows, mode),
      estimated: lastRow.estimated,
      stale: to >= now - 60_000 && now - lastRow.ts > limit,
    });
  }
  return series.sort((a, b) => a.key.localeCompare(b.key));
}

export interface HistoryOptions {
  provider: string;
  from: number;
  to: number;
  maxPoints?: number;
  /** Include per-account series alongside the merged view (history page). */
  includeAccounts?: boolean;
  /** Rows in the refresh log; 0 skips the log entirely. */
  logLimit?: number;
  intervalMs?: number;
  now?: number;
}

function logFrom(samples: readonly StoredSample[], rows: readonly StoredRow[]): HistoryLogEntry[] {
  const bySample = new Map<number, HistoryLogRow[]>();
  for (const r of rows) {
    const v = valueOf(r, rowMode(r.kind));
    const list = bySample.get(r.sampleId);
    const entry: HistoryLogRow = {
      scope: r.scope,
      kind: r.kind,
      label: r.label || r.kind,
      v: v === null ? null : Math.round(v * 100) / 100,
      u: r.used,
      n: r.total,
      unit: r.unit,
    };
    if (list) list.push(entry);
    else bySample.set(r.sampleId, [entry]);
  }
  return samples
    .map((s) => ({
      id: s.id,
      ts: s.ts,
      source: s.source,
      ok: s.ok,
      errKind: s.errKind,
      errText: s.errText,
      planLabel: s.planLabel,
      partial: s.partial,
      stale: s.stale,
      rows: bySample.get(s.id) ?? [],
    }))
    .reverse(); // newest first — the table is read top-down
}

/** Full history for one provider: chart series + the refresh log. */
export function buildProviderHistory(opts: HistoryOptions): ProviderHistory {
  const { provider, from, to, includeAccounts = false, logLimit = 200 } = opts;
  const scope = includeAccounts ? undefined : MERGED;
  const points = pointsInRange({ provider, from, to, scope });
  const series = buildSeries({
    provider,
    points,
    maxPoints: opts.maxPoints,
    intervalMs: opts.intervalMs,
    now: opts.now,
    to,
  });
  const samples = logLimit > 0 ? samplesInRange({ provider, from, to }) : [];
  return {
    provider,
    from,
    to,
    series,
    log: logFrom(samples, points).slice(0, logLimit),
    samples: samples.length,
  };
}

export interface DashboardHistory {
  ok: true;
  from: number;
  to: number;
  pollIntervalMs: number;
  truncated?: boolean;
  providers: Record<string, { series: HistorySeries[] }>;
}

/** Short-window history for the dashboard's per-card sparklines. */
export function buildDashboardHistory(from: number, to: number, maxPoints = 40): DashboardHistory {
  const data = fetchAll(from, to);
  const providers: DashboardHistory['providers'] = {};
  for (const p of data.providers) {
    providers[p.provider] = { series: buildSeries({ provider: p.provider, points: p.points, maxPoints, to }) };
  }
  return {
    ok: true,
    from,
    to,
    pollIntervalMs: pollIntervalMs(),
    ...(data.truncated ? { truncated: true } : {}),
    providers,
  };
}

export { MERGED };
