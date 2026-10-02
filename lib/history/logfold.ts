/**
 * Collapse runs of identical reads in the refresh log.
 *
 * Sampling every 5 minutes for 24 hours produces ~290 rows that are mostly the
 * same two numbers, which buries the handful of rows that actually changed. A
 * run keeps its first and last entry and becomes a marker in between:
 *
 *   11:30 1% / 3%   ← kept
 *   ⋯ 22 identical reads (11:35 → 12:55)
 *   12:55 1% / 3%   ← kept
 *
 * "Identical" means the same readings *and* the same outcome — a run is broken
 * by any change in a value, an error, or the account set, so a failure is never
 * swallowed by the fold.
 */

export interface LogReadings {
  scope: string;
  kind: string;
  /** Plotted value; rounded the same way the table shows it. */
  v: number | null;
  u: number | null;
}

export interface FoldableEntry {
  ts: number;
  ok: boolean;
  errKind: string | null;
  errScopes: string[];
  rows: readonly LogReadings[];
}

export type LogItem<T> =
  | { type: 'entry'; entry: T }
  | { type: 'fold'; count: number; from: number; to: number };

/**
 * Two reads are identical when the log *shows* the same thing: same outcome,
 * same account set, same displayed value per row.
 *
 * The absolute used/total counters are deliberately not compared — a counter
 * that ticks up while the percentage stays at 1% is still the same reading to
 * the eye, and comparing them is what kept runs from ever folding.
 */
export function sameReadings(a: FoldableEntry, b: FoldableEntry): boolean {
  if (a.ok !== b.ok) return false;
  if (a.errKind !== b.errKind) return false;
  if (a.errScopes.join(',') !== b.errScopes.join(',')) return false;
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every((r, i) => {
    const o = b.rows[i];
    return r.scope === o.scope && r.kind === o.kind && r.v === o.v;
  });
}

/**
 * Fold a newest-first log. `keepRun` is the minimum run length worth hiding;
 * a run of two is not noise, so it is left alone.
 */
export function foldLog<T extends FoldableEntry>(
  log: readonly T[],
  keepRun = 3,
): LogItem<T>[] {
  const items: LogItem<T>[] = [];
  let i = 0;
  while (i < log.length) {
    let j = i;
    while (j + 1 < log.length && sameReadings(log[i], log[j + 1])) j++;
    const runLength = j - i + 1;
    if (runLength >= keepRun) {
      items.push({ type: 'entry', entry: log[i] });
      // The span of the *hidden* rows, oldest → newest, for the label.
      items.push({ type: 'fold', count: runLength - 2, from: log[j - 1].ts, to: log[i + 1].ts });
      items.push({ type: 'entry', entry: log[j] });
    } else {
      for (let k = i; k <= j; k++) items.push({ type: 'entry', entry: log[k] });
    }
    i = j + 1;
  }
  return items;
}
