import { afterEach, describe, expect, it } from 'vitest';
import {
  accountEnvName,
  fetchMultiAccount,
  mergeLimits,
  readIndexedAccounts,
} from './accounts';
import type { ProviderResult, UsageLimit } from './types';

const ENV_VARS = ['TEST_PROVIDER_KEY', 'TEST_PROVIDER_PATH'] as const;

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const v of ENV_VARS) {
    for (let n = 1; n <= 9; n++) setEnv(n === 1 ? v : `${v}_${n}`);
  }
});

describe('readIndexedAccounts', () => {
  it('always includes account 1 from unsuffixed vars', () => {
    setEnv('TEST_PROVIDER_KEY', 'k1');
    const accounts = readIndexedAccounts({ vars: [...ENV_VARS] });
    expect(accounts.map((a) => a.key)).toEqual(['1']);
    expect(accounts[0].env.TEST_PROVIDER_KEY).toBe('k1');
  });

  it('picks up suffixed accounts and tolerates numbering gaps', () => {
    setEnv('TEST_PROVIDER_KEY', 'k1');
    // _2 intentionally absent; _3 must still be found.
    setEnv('TEST_PROVIDER_KEY_3', 'k3');
    setEnv('TEST_PROVIDER_PATH_5', 'p5');
    const accounts = readIndexedAccounts({ vars: [...ENV_VARS] });
    expect(accounts.map((a) => a.key)).toEqual(['1', '3', '5']);
    expect(accounts[1].env.TEST_PROVIDER_KEY).toBe('k3');
    expect(accounts[2].env.TEST_PROVIDER_PATH).toBe('p5');
  });

  it('triggerVars restrict what creates an extra account', () => {
    setEnv('TEST_PROVIDER_PATH_2', 'p2'); // secondary var only — not a trigger
    const accounts = readIndexedAccounts({
      vars: [...ENV_VARS],
      triggerVars: ['TEST_PROVIDER_KEY'],
    });
    expect(accounts.map((a) => a.key)).toEqual(['1']);
  });
});

describe('accountEnvName', () => {
  it('keeps the base name for account 1 and suffixes the rest', () => {
    expect(accountEnvName('GLM_API_KEY', '1')).toBe('GLM_API_KEY');
    expect(accountEnvName('GLM_API_KEY', '3')).toBe('GLM_API_KEY_3');
  });
});

describe('mergeLimits', () => {
  it('merges exact accounts by absolute quota (Σused / Σtotal)', () => {
    const merged = mergeLimits([
      { label: '5h Window', kind: '5h', percent: 20, used: 100, total: 500 },
      { label: '5h Window', kind: '5h', percent: 60, used: 300, total: 500 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].percent).toBe(40); // 400/1000 — NOT the mean of 20/60
    expect(merged[0].used).toBe(400);
    expect(merged[0].total).toBe(1000);
    expect(merged[0].estimated).toBeUndefined();
  });

  it('falls back to a flagged mean when accounts report percentages only', () => {
    const merged = mergeLimits([
      { label: 'Weekly', kind: 'weekly', percent: 30 },
      { label: 'Weekly', kind: 'weekly', percent: 70 },
    ]);
    expect(merged[0].percent).toBe(50);
    expect(merged[0].estimated).toBe(true);
    expect(merged[0].used).toBeUndefined();
  });

  it('derives a quota-weighted expectedPercent so merged rows keep pace deltas', () => {
    const now = Date.now();
    // 2.5h left of a 5h window → 50% expected; 1h left → 80% expected.
    const r1 = new Date(now + 2.5 * 3600e3).toISOString();
    const r2 = new Date(now + 1 * 3600e3).toISOString();
    const merged = mergeLimits([
      { label: '5h Window', kind: '5h', percent: 50, used: 250, total: 500, resetAt: r1 },
      { label: '5h Window', kind: '5h', percent: 80, used: 100, total: 125, resetAt: r2 },
    ]);
    // Quota weights 500 vs 125 → (50·500 + 80·125) / 625 = 56
    expect(merged[0].expectedPercent).toBeCloseTo(56, 0);
  });

  it('omits expectedPercent when any account lacks a reset time', () => {
    const merged = mergeLimits([
      { label: '5h Window', kind: '5h', percent: 10, resetAt: new Date(Date.now() + 3600e3).toISOString() },
      { label: '5h Window', kind: '5h', percent: 20 },
    ]);
    expect(merged[0].expectedPercent).toBeUndefined();
  });

  it('groups by kind and takes the earliest reset across accounts', () => {
    const later = '2026-08-10T12:00:00.000Z';
    const sooner = '2026-08-09T08:00:00.000Z';
    const merged = mergeLimits([
      { label: '5h Window', kind: '5h', percent: 10, resetAt: later },
      { label: 'Weekly', kind: 'weekly', percent: 20, resetAt: later },
      { label: '5h Window', kind: '5h', percent: 30, resetAt: sooner },
    ]);
    expect(merged.map((l) => l.kind)).toEqual(['5h', 'weekly']);
    const fiveH = merged.find((l) => l.kind === '5h')!;
    expect(fiveH.resetAt).toBe(sooner);
    expect(fiveH.percent).toBe(20); // mean of 10/30, percent-only
  });
});

describe('fetchMultiAccount', () => {
  const meta = { provider: 'kimi', label: 'Kimi' } as const;
  const ok = (percent: number, planLabel = 'Allegro'): ProviderResult => ({
    ok: true,
    provider: 'kimi',
    label: 'Kimi',
    summary: { planLabel, limits: [{ label: '5h Window', kind: '5h', percent }] },
  });

  it('passes a single account through untouched (no toggle data)', async () => {
    const single = ok(42);
    const result = await fetchMultiAccount(
      [{ key: '1', config: 0 }],
      async () => single,
      meta,
    );
    expect(result).toBe(single);
    expect(result.summary?.accounts).toBeUndefined();
  });

  it('merges accounts and exposes per-account views without credentials', async () => {
    const result = await fetchMultiAccount(
      [
        { key: '1', config: 'secret-key-1' },
        { key: '2', config: 'secret-key-2' },
      ],
      async (config) => {
        expect(config).toMatch(/^secret-key-/); // fetch receives the real config…
        return ok(config === 'secret-key-1' ? 20 : 60, config === 'secret-key-1' ? 'Allegro' : 'Moderato');
      },
      meta,
    );
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Allegro + Moderato');
    expect(result.summary?.accounts).toHaveLength(2);
    // …but the serialized account views must not carry any credential material.
    const serialized = JSON.stringify(result.summary?.accounts);
    expect(serialized).not.toContain('secret-key');
    expect(result.summary?.accounts?.[0]).toMatchObject({ key: '1', ok: true });
  });

  it('merges only healthy accounts and marks the result partial on failure', async () => {
    const result = await fetchMultiAccount(
      [
        { key: '1', config: {} },
        { key: '2', config: {} },
      ],
      async (_config, ) => ok(50),
      meta,
    );
    expect(result.ok).toBe(true);
    expect(result.summary?.partial).toBeUndefined();

    const withFailure = await fetchMultiAccount(
      [
        { key: '1', config: 'good' },
        { key: '2', config: 'bad' },
      ],
      async (config) =>
        config === 'good'
          ? ok(50)
          : { ok: false, provider: 'kimi', label: 'Kimi', error: 'HTTP 401' },
      meta,
    );
    expect(withFailure.ok).toBe(true);
    expect(withFailure.summary?.partial).toBe(true);
    expect(withFailure.summary?.limits[0].percent).toBe(50); // only account 1
    expect(withFailure.summary?.accounts?.[1]).toMatchObject({ key: '2', ok: false, error: 'HTTP 401' });
  });

  it('fails the whole card when every account fails', async () => {
    const result = await fetchMultiAccount(
      [
        { key: '1', config: 'a' },
        { key: '3', config: 'b' },
      ],
      async (config) => ({
        ok: false as const,
        provider: 'kimi' as const,
        label: 'Kimi',
        error: `boom-${config}`,
      }),
      meta,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Account 1: boom-a');
    expect(result.error).toContain('Account 3: boom-b');
  });
});
