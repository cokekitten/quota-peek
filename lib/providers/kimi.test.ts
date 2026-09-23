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
});
