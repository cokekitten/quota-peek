import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchKimiUsage } from './kimi';

// Mirrors GET api.kimi.com/coding/v1/usages: the quota blocks carry
// limit/used counts whose limit is a percent denominator — the counts add
// nothing over the percentage itself.
const USAGES = {
  user: { membership: { level: 'LEVEL_ADVANCED' } },
  usage: {
    limit: '100',
    used: '84',
    remaining: '16',
    resetTime: '2026-09-30T00:00:00.000Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '7', remaining: '93', resetTime: '2026-09-24T05:00:00.000Z' },
    },
    {
      window: { duration: 10, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '1', remaining: '99' },
    },
  ],
};

afterEach(() => {
  for (const v of ['KIMI_API_KEY', 'KIMI_API_KEY_2', 'KIMI_CREDENTIALS_PATH']) {
    for (const n of [undefined, 2]) delete process.env[n === undefined ? v : `${v}_${n}`];
  }
  vi.unstubAllGlobals();
});

describe('fetchKimiUsage', () => {
  it('reports percentages and reset times, not the meaningless used/limit counts', async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(USAGES), { status: 200 })),
    );

    const r = await fetchKimiUsage();
    expect(r.ok).toBe(true);
    const rows = r.summary!.limits;
    expect(rows.map((l) => l.kind)).toEqual(['5h', 'weekly']);
    expect(rows[0]).toMatchObject({ label: '5h Window', percent: 7 });
    expect(rows[1]).toMatchObject({ label: 'Weekly', percent: 84 });
    for (const row of rows) {
      expect(row.used).toBeUndefined();
      expect(row.total).toBeUndefined();
    }
    // resetTime still drives the countdown
    expect(rows[0].resetAt).toBe('2026-09-24T05:00:00.000Z');
    expect(rows[1].resetAt).toBe('2026-09-30T00:00:00.000Z');
    expect(r.summary?.planLabel).toBe('Allegro');
  });

  it('merges same-level accounts without the ≈ estimate flag', async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-a';
    process.env.KIMI_API_KEY_2 = 'sk-kimi-b';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('Authorization') || '';
        // two Allegro accounts: 5h at 7% / 21%, weekly at 84% / 42%
        const [five, week] = auth === 'Bearer sk-kimi-a' ? [7, 84] : [21, 42];
        return new Response(
          JSON.stringify({
            user: { membership: { level: 'LEVEL_ADVANCED' } },
            usage: { limit: '100', used: String(week), remaining: String(100 - week) },
            limits: [
              {
                window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
                detail: { limit: '100', used: String(five), remaining: String(100 - five) },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const r = await fetchKimiUsage();
    const rows = r.summary!.limits;
    // equal-capacity windows: the mean IS the combined utilization (14 / 63)
    expect(rows[0]).toMatchObject({ kind: '5h', percent: 14 });
    expect(rows[1]).toMatchObject({ kind: 'weekly', percent: 63 });
    expect(rows[0].estimated).toBeUndefined();
    expect(rows[1].estimated).toBeUndefined();
  });

  it('flags the ≈ estimate when the accounts sit on different plans', async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-a';
    process.env.KIMI_API_KEY_2 = 'sk-kimi-b';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('Authorization') || '';
        const level = auth === 'Bearer sk-kimi-a' ? 'LEVEL_ADVANCED' : 'LEVEL_PREMIUM';
        return new Response(
          JSON.stringify({
            user: { membership: { level } },
            usage: { limit: '100', used: '50', remaining: '50' },
          }),
          { status: 200 },
        );
      }),
    );

    const r = await fetchKimiUsage();
    expect(r.summary!.limits[0].estimated).toBe(true);
  });
});
