import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from './db';
import { record, fetchAll, pointsInRange, prune, samplesInRange, sampleCount } from './store';
import { extractSample } from './extract';
import { buildProviderHistory, buildSeries } from './series';
import type { ProviderResult, UsageLimit } from '../providers/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-history-'));
  process.env.QP_DATA_DIR = dir;
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.QP_DATA_DIR;
});

const lim = (over: Partial<UsageLimit> = {}): UsageLimit => ({
  label: '5h Window',
  kind: '5h',
  percent: 40,
  ...over,
});

const result = (over: Partial<ProviderResult> = {}): ProviderResult => ({
  ok: true,
  provider: 'claude',
  label: 'Claude Code',
  summary: { planLabel: 'Max', limits: [lim()] },
  ...over,
});

/** Store one sample for `provider` at `ts` and return its id. */
function put(provider: string, ts: number, r: ProviderResult, source = 'poll'): number {
  const s = extractSample(r, source, ts);
  return record(s, ts).id;
}

describe('extractSample', () => {
  it('turns a merged card into one sample plus one row per window', () => {
    const s = extractSample(
      result({
        summary: {
          planLabel: 'Max 20x',
          limits: [lim({ kind: '5h', percent: 42 }), lim({ kind: 'weekly', percent: 7 })],
        },
      }),
      'poll',
      1000,
    );
    expect(s.ok).toBe(true);
    expect(s.planLabel).toBe('Max 20x');
    expect(s.errKind).toBeNull();
    expect(s.rows).toHaveLength(2);
    expect(s.hasPercent).toBe(true);
    expect(s.kinds).toEqual(['5h', 'weekly']);
  });

  it('keeps absolute figures and the unit for money rows', () => {
    const s = extractSample(
      result({
        provider: 'deepseek',
        summary: {
          limits: [
            { label: 'Balance', kind: 'balance', percent: 0, used: 143.59, unit: '¥' },
            { label: 'Spend', kind: 'spend', percent: 128, used: 2428.85, total: 1897.06, unit: '¥' },
          ],
        },
      }),
      'poll',
    );
    expect(s.hasAbsolute).toBe(true);
    expect(s.rows[0]).toMatchObject({ kind: 'balance', used: 143.59, unit: '¥' });
    expect(s.rows[1]).toMatchObject({ kind: 'spend', percent: 128, total: 1897.06 });
  });

  it('splits multi-account cards into merged + per-account scopes', () => {
    const s = extractSample(
      result({
        provider: 'kimi',
        summary: {
          limits: [lim({ kind: 'weekly', percent: 18 })],
          partial: true,
          accounts: [
            { key: '1', ok: true, limits: [lim({ kind: 'weekly', percent: 20 })] },
            { key: '2', ok: true, limits: [lim({ kind: 'weekly', percent: 16 })] },
            // A dead account leaves a sample-level error, not empty rows.
            { key: '3', ok: false, error: 'HTTP 401', limits: [] },
          ],
        },
      }),
      'poll',
    );
    expect(s.partial).toBe(true);
    expect(s.rows.map((r) => r.scope)).toEqual(['merged', '1', '2']);
    expect(s.rows.filter((r) => r.scope === 'merged')).toHaveLength(1);
  });

  it('classifies failures so a curve can tell "no spend" from "no data"', () => {
    const unconfigured = extractSample(
      result({ ok: false, notConfigured: true, error: 'set GLM_API_KEY', summary: undefined }),
      'poll',
    );
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.errKind).toBe('not_configured');
    expect(unconfigured.rows).toHaveLength(0);

    const failed = extractSample(result({ ok: false, error: 'HTTP 429', summary: undefined }), 'poll');
    expect(failed.errKind).toBe('error');
  });

  it('normalizes a missing/invalid reset time to null instead of NaN', () => {
    const s = extractSample(
      result({ summary: { limits: [lim({ resetAt: 'nonsense' })] } }),
      'poll',
    );
    expect(s.rows[0].resetAt).toBeNull();
  });
});

describe('store', () => {
  it('round-trips a sample with its rows', () => {
    const ts = Date.now();
    const id = put('claude', ts, result());
    const samples = samplesInRange({ provider: 'claude', from: ts - 1, to: ts + 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ id, provider: 'claude', source: 'poll', ok: true, planLabel: 'Max' });
    const points = pointsInRange({ provider: 'claude', from: ts - 1, to: ts + 1 });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ scope: 'merged', kind: '5h', percent: 40, resetAt: null });
  });

  it('keeps series apart per (provider, scope, kind)', () => {
    const now = Date.now();
    put('kimi', now, result({ provider: 'kimi', summary: {
      limits: [lim({ kind: 'weekly', percent: 18 })],
      accounts: [
        { key: '1', ok: true, limits: [lim({ kind: 'weekly', percent: 20 })] },
        { key: '2', ok: true, limits: [lim({ kind: 'weekly', percent: 16 })] },
      ],
    } }));
    const points = pointsInRange({ provider: 'kimi', from: now - 1, to: now + 1 });
    expect(points.map((p) => `${p.scope}:${p.kind}`).sort()).toEqual(['1:weekly', '2:weekly', 'merged:weekly']);
    // scope filter keeps the per-account views out of the dashboard request
    expect(pointsInRange({ provider: 'kimi', from: now - 1, to: now + 1, scope: 'merged' })).toHaveLength(1);
  });

  it('never throws on a broken store — it reports `skipped` instead', () => {
    const r = record({ provider: 'claude', source: 'poll', ok: true, rows: [{ scope: 'merged', kind: '5h', percent: 1 }] });
    expect(r.id).toBeGreaterThan(0);
    closeDb();
    // Point the store at an unwritable path: writing must degrade, not crash.
    process.env.QP_DATA_DIR = path.join(dir, 'file-in-the-way');
    fs.writeFileSync(path.join(dir, 'file-in-the-way'), 'not a dir');
    const bad = record({ provider: 'claude', source: 'poll', ok: true, rows: [] });
    expect(bad.skipped).toBeTruthy();
  });

  it('prunes samples (and cascades their rows) past the retention window', () => {
    const now = Date.now();
    const old = now - 10 * 864e5;
    put('claude', old, result());
    put('claude', now, result());
    expect(sampleCount()).toBe(2);
    const res = prune(7, now);
    expect(res.samples).toBe(1);
    expect(res.rows).toBe(1);
    expect(pointsInRange({ provider: 'claude', from: 0, to: now + 1 })).toHaveLength(1);
  });
});

describe('buildSeries', () => {
  const T0 = 1_700_000_000_000;
  const at = (i: number) => T0 + i * 300_000; // 5-minute polls

  function rows(
    series: {
      scope?: string;
      kind?: string;
      ts?: number;
      percent?: number | null;
      resetAt?: number | null;
      used?: number | null;
      total?: number | null;
      unit?: string | null;
    }[],
  ) {
    return series.map((s, i) => ({
      id: i + 1,
      sampleId: i + 1,
      ts: s.ts ?? at(i),
      ok: true,
      errKind: null,
      scope: s.scope ?? 'merged',
      kind: s.kind ?? '5h',
      label: '5h Window',
      percent: s.percent ?? null,
      used: s.used ?? null,
      total: s.total ?? null,
      unit: s.unit ?? null,
      resetAt: s.resetAt ?? null,
      estimated: false,
    }));
  }

  it('reports a percentage-point delta against the previous reading', () => {
    const s = buildSeries({ provider: 'claude', points: rows([{ percent: 40 }, { percent: 42.5 }]), to: at(1), now: at(1) });
    expect(s).toHaveLength(1);
    expect(s[0].mode).toBe('percent');
    expect(s[0].delta).toMatchObject({ kind: 'pp', value: 2.5, at: at(0) });
    expect(s[0].last).toMatchObject({ v: 42.5, at: at(1) });
  });

  it('suppresses the delta when the window clock moved (a reset is not a drop)', () => {
    const resetA = T0 + 4 * 3600e3;
    const resetB = resetA + 5 * 3600e3;
    const s = buildSeries({
      provider: 'claude',
      points: rows([
        { percent: 98, resetAt: resetA },
        { percent: 0, resetAt: resetB },
        { percent: 3, resetAt: resetB },
      ]),
      to: at(2),
      now: at(2),
    });
    // Never "-98%": the rollover suppresses it, and the real change is +3pp.
    expect(s[0].delta).toMatchObject({ kind: 'pp', value: 3 });
    expect(s[0].points[1].reset).toBe(1);
  });

  it('flags a rollover as the delta when it is the newest change', () => {
    const resetA = T0 + 4 * 3600e3;
    const s = buildSeries({
      provider: 'claude',
      points: rows([{ percent: 98, resetAt: resetA }, { percent: 0, resetAt: resetA + 5 * 3600e3 }]),
      to: at(1),
      now: at(1),
    });
    expect(s[0].delta).toEqual({ kind: 'reset', at: at(0) });
  });

  it('uses money deltas for balance rows and flags a stalled poller', () => {
    const s = buildSeries({
      provider: 'deepseek',
      points: rows([
        { kind: 'balance', percent: 0, used: 143.59, unit: '¥' },
        { kind: 'balance', percent: 0, used: 141.09, unit: '¥' },
      ]),
      // The range reaches "now" but the newest reading is an hour old.
      to: at(1) + 60 * 60e3,
      now: at(1) + 60 * 60e3,
    });
    expect(s[0].mode).toBe('absolute');
    expect(s[0].delta).toMatchObject({ kind: 'abs', value: -2.5, unit: '¥' });
    expect(s[0].stale).toBe(true);
  });

  it('breaks the line across a poller gap instead of inventing a slope', () => {
    const s = buildSeries({
      provider: 'claude',
      points: rows([{ percent: 10, ts: at(0) }, { percent: 20, ts: at(1) }, { percent: 25, ts: at(40) }]),
      to: at(40),
      now: at(40),
    });
    expect(s[0].points[2].br).toBe(1);
    expect(s[0].points[1].br).toBeUndefined();
  });

  it('downsamples to the point budget by averaging inside time buckets', () => {
    const many = rows(Array.from({ length: 500 }, (_, i) => ({ percent: i % 50, ts: at(i) })));
    const s = buildSeries({ provider: 'claude', points: many, maxPoints: 40, to: at(499), now: at(499) });
    expect(s[0].points.length).toBeLessThanOrEqual(40);
    expect(s[0].points.length).toBeGreaterThan(1);
    // The delta still comes from the raw readings (i%50: 48 → 49), not the buckets.
    expect(s[0].delta).toMatchObject({ kind: 'pp', value: 1, at: at(498) });
  });

  it('skips rows with nothing plottable rather than charting zeros', () => {
    const s = buildSeries({ provider: 'claude', points: rows([{ percent: null }, { percent: null }]), to: at(1) });
    expect(s[0].points).toHaveLength(0);
    expect(s[0].delta).toBeNull();
  });
});

describe('buildProviderHistory', () => {
  it('returns merged series only, plus a newest-first refresh log', () => {
    const now = Date.now();
    put('kimi', now - 20 * 60_000, result({ provider: 'kimi', summary: {
      limits: [lim({ kind: 'weekly', percent: 18 })],
      accounts: [
        { key: '1', ok: true, limits: [lim({ kind: 'weekly', percent: 20 })] },
        { key: '2', ok: true, limits: [lim({ kind: 'weekly', percent: 16 })] },
      ],
    } }), 'poll');
    put('kimi', now, result({ provider: 'kimi', summary: {
      limits: [lim({ kind: 'weekly', percent: 19 })],
      accounts: [
        { key: '1', ok: true, limits: [lim({ kind: 'weekly', percent: 20 })] },
        { key: '2', ok: true, limits: [lim({ kind: 'weekly', percent: 18 })] },
      ],
    } }), 'page');
    put('kimi', now + 1000, result({ provider: 'kimi', ok: false, error: 'HTTP 500', summary: undefined }), 'page');

    const h = buildProviderHistory({ provider: 'kimi', from: now - 3600e3, to: now + 2000, now: now + 2000 });
    expect(h.series.map((s) => s.key)).toEqual(['merged:weekly']);
    expect(h.series[0].delta).toMatchObject({ kind: 'pp', value: 1 });
    expect(h.log.map((l) => l.source)).toEqual(['page', 'page', 'poll']); // newest first
    expect(h.log[0]).toMatchObject({ ok: false, errKind: 'error', errText: 'HTTP 500' });
    expect(h.log[2].rows[0]).toMatchObject({ scope: 'merged', kind: 'weekly', v: 18 });

    // includeAccounts adds the per-account curves on top of the merged one.
    const full = buildProviderHistory({
      provider: 'kimi',
      from: now - 3600e3,
      to: now + 2000,
      includeAccounts: true,
      now: now + 2000,
    });
    expect(full.series.map((s) => s.key)).toEqual(['1:weekly', '2:weekly', 'merged:weekly']);
  });
});

describe('fetchAll', () => {
  it('groups every provider in the window', () => {
    const now = Date.now();
    put('claude', now, result());
    put('glm', now, result({ provider: 'glm' }));
    const data = fetchAll(now - 1000, now + 1000);
    expect(data.providers.map((p) => p.provider)).toEqual(['claude', 'glm']);
    expect(data.providers[0].points).toHaveLength(1);
  });

  it('is empty (not broken) when nothing has been recorded yet', () => {
    const data = fetchAll(Date.now() - 1000, Date.now());
    expect(data.providers).toEqual([]);
  });
});

describe('schema guard', () => {
  it('creates the db file on first open', () => {
    getDb();
    expect(fs.existsSync(path.join(dir, 'quota-peek.db'))).toBe(true);
  });

  it('refuses to reuse a db whose columns are not the ones we read', () => {
    getDb();
    closeDb();
    // Simulate an older/foreign build: drop a column the code selects.
    const raw = new (require('better-sqlite3'))(path.join(dir, 'quota-peek.db'));
    raw.exec('ALTER TABLE sample DROP COLUMN stale');
    raw.close();
    expect(() => getDb()).toThrow(/does not match the expected schema/);
    closeDb();
  });

  it('accepts a database created outside the app (no marker file)', () => {
    // A db built by scripts/seed-demo-history.mjs has the same tables but was
    // never touched by getDb() — opening it must work, not fail on a flag.
    const raw = new (require('better-sqlite3'))(path.join(dir, 'quota-peek.db'));
    raw.exec(`CREATE TABLE sample (id INTEGER PRIMARY KEY, ts INTEGER, provider TEXT, source TEXT,
        ok INTEGER, err_kind TEXT, err_text TEXT, plan_label TEXT, partial INTEGER, stale INTEGER);
      CREATE TABLE sample_row (id INTEGER PRIMARY KEY, sample_id INTEGER, scope TEXT, kind TEXT,
        label TEXT, percent REAL, used REAL, total REAL, unit TEXT, reset_at INTEGER, estimated INTEGER);`);
    raw.close();
    expect(() => getDb()).not.toThrow();
  });
});

describe('money rows are read in their own unit', () => {
  const T0 = 1_700_000_000_000;
  const rows = (spec: { kind: string; percent: number | null; used: number | null; total?: number | null; unit?: string | null }[]) =>
    spec.map((s, i) => ({
      id: i + 1,
      sampleId: i + 1,
      ts: T0 + i * 300_000,
      ok: true,
      errKind: null,
      scope: 'merged',
      kind: s.kind,
      label: s.kind,
      percent: s.percent,
      used: s.used,
      total: s.total ?? null,
      unit: s.unit ?? null,
      resetAt: null,
      estimated: false,
    }));

  it('charts a Balance by its amount, not by its placeholder 0%', () => {
    // Every provider reports percent:0 for a balance — plotting that would be
    // a flat line at zero, hiding the fact that money is being spent.
    const s = buildSeries({
      provider: 'deepseek',
      points: rows([
        { kind: 'balance', percent: 0, used: 1587.53, unit: '¥' },
        { kind: 'balance', percent: 0, used: 1580.02, unit: '¥' },
      ]),
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].mode).toBe('absolute');
    expect(s[0].points.map((p) => p.v)).toEqual([1587.53, 1580.02]);
    expect(s[0].last).toMatchObject({ v: 1580.02, u: 1580.02 });
    expect(s[0].delta).toMatchObject({ kind: 'abs', unit: '¥' });
    expect((s[0].delta as { value: number }).value).toBeCloseTo(-7.51, 6);
  });

  it('charts a Spend row by money spent even when a percentage exists', () => {
    const s = buildSeries({
      provider: 'deepseek',
      points: rows([
        { kind: 'spend', percent: 0.35, used: 5.58, total: 1587.53, unit: '¥' },
        { kind: 'spend', percent: 0.41, used: 6.51, total: 1580.02, unit: '¥' },
      ]),
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].mode).toBe('absolute');
    expect(s[0].points.map((p) => p.v)).toEqual([5.58, 6.51]);
  });

  it('still charts window rows by percentage', () => {
    const s = buildSeries({
      provider: 'claude',
      points: rows([
        { kind: '5h', percent: 40, used: 1_000_000, total: 2_500_000 },
        { kind: '5h', percent: 42, used: 1_050_000, total: 2_500_000 },
      ]),
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].mode).toBe('percent');
    expect(s[0].points.map((p) => p.v)).toEqual([40, 42]);
  });

  it('logs the same value the chart plots', () => {
    const now = Date.now();
    put('deepseek', now, result({ provider: 'deepseek', summary: {
      limits: [{ label: 'Balance', kind: 'balance', percent: 0, used: 1580.02, unit: '¥' }],
    } }), 'poll');
    const h = buildProviderHistory({ provider: 'deepseek', from: now - 1000, to: now + 1000, now });
    expect(h.log[0].rows[0]).toMatchObject({ kind: 'balance', v: 1580.02, u: 1580.02, unit: '¥' });
    expect(h.series[0].last?.v).toBe(1580.02);
  });
});

describe('retention and log window', () => {
  const now = Date.now();

  it('keeps the newest reads when a range holds more samples than the log cap', () => {
    // 3 days at a 5-minute interval = 864 samples; cap the log at 10.
    for (let i = 0; i < 30; i++) put('claude', now - i * 5 * 60_000, result());
    const h = buildProviderHistory({
      provider: 'claude',
      from: now - 3 * 864e5,
      to: now,
      logLimit: 10,
      now,
    });
    expect(h.log).toHaveLength(10);
    // Newest first — the point of the log is "what did the last read see".
    expect(h.log[0].ts).toBe(now);
    expect(h.log[9].ts).toBe(now - 9 * 5 * 60_000);
  });

  it('prunes once a day from the poller, not on every round', async () => {
    process.env.QP_HISTORY_DAYS = '1';
    const old = now - 3 * 864e5;
    const { record } = await import('./store');
    record(extractSample(result(), 'poll', old), old);
    expect(sampleCount()).toBe(1);

    const { pollIfIdle, resetPoller: reset } = await import('./poller');
    // Round 1 (fresh process) prunes the expired sample…
    const first = await pollIfIdle({ keys: [], fetchUsage: async (p) => result() });
    expect(first?.pruned).toBe(true);
    expect(sampleCount()).toBe(0);

    // …and round 2, minutes later, does not bother.
    const second = await pollIfIdle({ keys: [], fetchUsage: async (p) => result() });
    expect(second?.pruned).toBe(false);

    delete process.env.QP_HISTORY_DAYS;
    void reset;
  });
});

describe('a drop no window reset explains', () => {
  const T0 = 1_700_000_000_000;
  const row = (pct: number, resetAt: number | null) => ({
    id: 0,
    sampleId: 0,
    ts: T0,
    ok: true,
    errKind: null,
    scope: 'merged',
    kind: '5h',
    label: '5h Window',
    percent: pct,
    used: null,
    total: null,
    unit: null,
    resetAt,
    estimated: false,
  });

  it('flags a large drop when the reset clock did not move', () => {
    const r = T0 + 4 * 3600e3;
    const s = buildSeries({
      provider: 'kimi',
      points: [row(15, r), { ...row(10, r), ts: T0 + 300_000 }],
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    // The Σ membership changed (2 accounts → 3): -5pp is below the bar, so…
    expect(s[0].delta).toMatchObject({ kind: 'pp', value: -5 });
    expect((s[0].delta as { suspect?: string }).suspect).toBeUndefined();

    // …but a -12pp drop with the same reset clock is flagged for the tooltip.
    const big = buildSeries({
      provider: 'kimi',
      points: [row(40, r), { ...row(28, r), ts: T0 + 300_000 }],
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(big[0].delta).toMatchObject({ kind: 'pp', value: -12, suspect: 'stable-reset' });
  });

  it('says so when the row carries no reset time to check against', () => {
    const s = buildSeries({
      provider: 'mystery',
      points: [row(60, null), { ...row(30, null), ts: T0 + 300_000 }],
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].delta).toMatchObject({ value: -30, suspect: 'no-reset-info' });
  });

  it('never flags a money row — a balance going down is its normal direction', () => {
    const money = (used: number) => ({
      ...row(0, null),
      kind: 'balance',
      label: 'Balance',
      used,
      unit: '¥',
    });
    const s = buildSeries({
      provider: 'deepseek',
      points: [money(1587), { ...money(1200), ts: T0 + 300_000 }],
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].delta).toMatchObject({ kind: 'abs', value: -387 });
    expect((s[0].delta as { suspect?: string }).suspect).toBeUndefined();
  });

  it('still calls a real rollover a reset, never a suspicious drop', () => {
    const s = buildSeries({
      provider: 'claude',
      points: [row(98, T0 + 4 * 3600e3), { ...row(0, T0 + 9 * 3600e3), ts: T0 + 300_000 }],
      to: T0 + 300_000,
      now: T0 + 300_000,
    });
    expect(s[0].delta).toEqual({ kind: 'reset', at: T0 });
  });
});
