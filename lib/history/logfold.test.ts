import { describe, expect, it } from 'vitest';
import { foldLog, sameReadings, type FoldableEntry } from './logfold';

const at = (ts: number, over: Partial<FoldableEntry> = {}): FoldableEntry => ({
  ts,
  ok: true,
  errKind: null,
  errScopes: [],
  rows: [
    { scope: 'merged', kind: '5h', v: 1, u: null },
    { scope: 'merged', kind: 'weekly', v: 3, u: null },
  ],
  ...over,
});

const T = 1_800_000_000_000;
const log = (n: number, over: Partial<FoldableEntry> = {}) =>
  Array.from({ length: n }, (_, i) => at(T - i * 300_000, over));

describe('folding identical reads', () => {
  it('keeps the first and last of a run and folds the rest', () => {
    const items = foldLog(log(5));
    expect(items.map((i) => i.type)).toEqual(['entry', 'fold', 'entry']);
    const fold = items[1];
    expect(fold).toMatchObject({ type: 'fold', count: 3, from: T - 3 * 300_000, to: T - 300_000 });
    const entries = items.filter((i) => i.type === 'entry');
    expect(entries[0]).toMatchObject({ entry: { ts: T } });
    expect(entries[1]).toMatchObject({ entry: { ts: T - 4 * 300_000 } });
  });

  it('leaves a pair alone — two identical rows are not noise', () => {
    expect(foldLog(log(2)).map((i) => i.type)).toEqual(['entry', 'entry']);
  });

  it('folds when only the absolute counter ticked up, not the displayed value', () => {
    // The real case: used climbs every poll while the percentage stays at 1%.
    // Comparing `u` kept runs from ever folding.
    const a = at(T);
    const b = { ...at(T - 300_000), rows: a.rows.map((r) => ({ ...r, u: 125 })) };
    const c = { ...at(T - 600_000), rows: a.rows.map((r) => ({ ...r, u: 250 })) };
    expect(sameReadings(a, b)).toBe(true);
    expect(foldLog([a, b, c]).map((i) => i.type)).toEqual(['entry', 'fold', 'entry']);
  });

  it('breaks a run on a changed reading', () => {
    const mixed = [...log(2), at(T - 600_000, { rows: [{ scope: 'merged', kind: '5h', v: 2, u: null }] }), ...log(2)];
    const items = foldLog(mixed);
    expect(items.every((i) => i.type === 'entry')).toBe(true);
  });

  it('never folds away a failure', () => {
    const failed = at(T - 300_000, { ok: false, errKind: 'error' });
    const items = foldLog([at(T), failed, ...log(3)]);
    // The failure is its own single-row run, so it survives untouched…
    expect(items.filter((i) => i.type === 'entry').some((i) => i.entry === failed)).toBe(true);
    // …while the three identical polls after it still fold.
    expect(items.some((i) => i.type === 'fold')).toBe(true);
  });

  it('breaks a run when an account drops out, even with identical readings', () => {
    const healthy = at(T);
    const partial = at(T - 300_000, { errScopes: ['2'] });
    expect(sameReadings(healthy, partial)).toBe(false);
    // A repeated partial read is identical, so it can fold — the account set is
    // part of what "identical" means.
    const both = [partial, at(T - 600_000, { errScopes: ['2'] }), at(T - 900_000, { errScopes: ['2'] })];
    expect(foldLog(both).map((i) => i.type)).toEqual(['entry', 'fold', 'entry']);
  });

  it('handles an empty log and a single row', () => {
    expect(foldLog([])).toEqual([]);
    expect(foldLog(log(1)).map((i) => i.type)).toEqual(['entry']);
  });

  it('collapses a 24-hour wall of identical polls to two rows', () => {
    const items = foldLog(log(288));
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ type: 'fold', count: 286 });
  });
});
