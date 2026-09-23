import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenrouterUsage } from './openrouter';

const KEY = 'sk-or-v1-test';

afterEach(() => {
  for (const v of ['OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY', 'OPENROUTER_BASE_URL']) {
    for (const n of [undefined, 2, 3]) delete process.env[n === undefined ? v : `${v}_${n}`];
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Mirrors GET /api/v1/key (wire format is snake_case inside a data envelope).
const KEY_DATA = {
  label: 'Default',
  name: 'default',
  hash: 'abcd1234',
  workspace_id: null,
  creator_user_id: '42',
  external_user: null,
  disabled: false,
  include_byok_in_limit: false,
  created_at: '2026-01-05T00:00:00.000Z',
  updated_at: null,
  expires_at: null,
  usage: 25.75,
  usage_daily: 1.25,
  usage_weekly: 6.5,
  usage_monthly: 12.4,
  byok_usage: 0,
  byok_usage_daily: 0,
  byok_usage_weekly: 0,
  byok_usage_monthly: 0,
  limit: 50,
  limit_remaining: 30,
  limit_reset: 'monthly',
};

function mockOr(routes: Array<{ path: string; status?: number; body: unknown; auth?: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const route = routes.find((r) => url.includes(r.path));
      if (!route) throw new Error(`unexpected request ${url}`);
      if (route.auth) {
        const auth = new Headers(init?.headers).get('Authorization') || '';
        if (auth !== route.auth) throw new Error(`auth mismatch: ${auth}`);
      }
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(body, { status: route.status ?? 200 });
    }),
  );
}

describe('fetchOpenrouterUsage', () => {
  it('shows the Month Spend amount and the Key Limit bar', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    mockOr([{ path: '/api/v1/key', body: { data: KEY_DATA }, auth: `Bearer ${KEY}` }]);

    const r = await fetchOpenrouterUsage();
    expect(r.ok).toBe(true);
    const kinds = r.summary?.limits.map((l) => l.kind);
    expect(kinds).toEqual(['balance', 'monthly']);

    // Month Spend: a bare money amount, rolling over at the UTC month boundary
    const spend = r.summary?.limits[0];
    expect(spend).toMatchObject({ label: 'Month Spend', kind: 'balance', used: 12.4, unit: '$' });
    expect(spend?.total).toBeUndefined();
    const spendReset = new Date(spend?.resetAt!);
    expect(spendReset.getUTCDate()).toBe(1);
    expect(spendReset.getUTCHours()).toBe(0);
    expect(spendReset.getUTCMonth()).toBe((new Date().getUTCMonth() + 1) % 12);

    // Key Limit: 50 − 30 = 20 of the cap burned → 40%
    const cap = r.summary?.limits[1];
    expect(cap).toMatchObject({
      label: 'Key Limit',
      kind: 'monthly',
      percent: 40,
      used: 20,
      total: 50,
      unit: '$',
    });
  });

  it('maps limit_reset cadences onto the window rollover', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T13:24:00Z')); // a Wednesday
    const cases: Array<[reset: string | null, kind: string, resetAt: string | undefined]> = [
      ['daily', 'daily', '2026-09-24T00:00:00.000Z'],
      ['weekly', 'weekly', '2026-09-28T00:00:00.000Z'], // next Monday (UTC weeks are Mon–Sun)
      ['monthly', 'monthly', '2026-10-01T00:00:00.000Z'],
      [null, 'cap', undefined],
    ];
    for (const [limit_reset, kind, resetAt] of cases) {
      mockOr([
        { path: '/api/v1/key', body: { data: { ...KEY_DATA, limit_reset } } },
      ]);
      const r = await fetchOpenrouterUsage();
      const cap = r.summary?.limits[1];
      expect(cap?.kind, `limit_reset=${limit_reset}`).toBe(kind);
      expect(cap?.resetAt, `limit_reset=${limit_reset}`).toBe(resetAt);
    }
  });

  it('combines the wallet balance into a Spend / Balance money row', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      { path: '/api/v1/key', body: { data: KEY_DATA }, auth: `Bearer ${KEY}` },
      {
        path: '/api/v1/credits',
        body: { data: { total_credits: 100, total_usage: 83.7 } }, // wallet left $16.3
        auth: 'Bearer sk-or-mgmt',
      },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['spend', 'monthly']);
    // 12.4 / (12.4 + 16.3) = 43.2% — pool share, MiMo-style
    expect(r.summary?.limits[0]).toMatchObject({
      label: 'Spend / Balance',
      kind: 'spend',
      percent: 43.2,
      used: 12.4,
      total: 16.3,
      unit: '$',
    });
    expect(new Date(r.summary?.limits[0].resetAt!).getUTCDate()).toBe(1);
  });

  it('shows a cumulative Usage / Balance row with the management key alone', async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      {
        path: '/api/v1/credits',
        body: { data: { total_credits: 100, total_usage: 30 } },
        auth: 'Bearer sk-or-mgmt',
      },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toHaveLength(1);
    // $30 spent of the $100 ever purchased → 30% pool share, no month window
    expect(r.summary?.limits[0]).toMatchObject({
      label: 'Usage / Balance',
      kind: 'spend',
      percent: 30,
      used: 30,
      total: 70,
      unit: '$',
    });
    expect(r.summary?.limits[0].resetAt).toBeUndefined();
  });

  it('omits the Key Limit row when the key has no cap', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    mockOr([
      {
        path: '/api/v1/key',
        body: { data: { ...KEY_DATA, limit: null, limit_remaining: null, limit_reset: null } },
      },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['balance']);
  });

  it('prefers the account-wide month spend from analytics', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    let queryBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/v1/analytics/query')) {
          queryBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              data: {
                data: [
                  { date__day: '2026-09-22', total_usage: 67.83 },
                  { date__day: '2026-09-23', total_usage: 0.09886 },
                ],
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes('/api/v1/credits')) {
          return new Response(
            JSON.stringify({ data: { total_credits: 100, total_usage: 83.7 } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: KEY_DATA }), { status: 200 });
      }),
    );

    const r = await fetchOpenrouterUsage();
    // the whole account's month (67.93), not the fresh key's own 12.4
    expect(r.summary?.limits[0]).toMatchObject({
      label: 'Spend / Balance',
      kind: 'spend',
      used: 67.93,
      total: 16.3,
      percent: 80.6,
    });
    expect(queryBody?.metrics).toEqual(['total_usage']);
    const range = queryBody?.time_range as { start: string };
    expect(new Date(range.start).getUTCDate()).toBe(1); // the UTC month start
  });

  it('falls back to the key sum when analytics is unavailable', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      { path: '/api/v1/analytics/query', status: 500, body: 'boom' },
      {
        path: '/api/v1/credits',
        body: { data: { total_credits: 100, total_usage: 83.7 } },
        auth: 'Bearer sk-or-mgmt',
      },
      { path: '/api/v1/key', body: { data: KEY_DATA }, auth: `Bearer ${KEY}` },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.summary?.limits[0]).toMatchObject({
      label: 'Spend / Balance',
      used: 12.4,
      total: 16.3,
      percent: 43.2,
    });
  });

  it('shows the month Spend / Balance with the management key alone when analytics answers', async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      {
        path: '/api/v1/analytics/query',
        body: { data: { data: [{ date__day: '2026-09-23', total_usage: 5 }] } },
        auth: 'Bearer sk-or-mgmt',
      },
      {
        path: '/api/v1/credits',
        body: { data: { total_credits: 100, total_usage: 83.7 } },
        auth: 'Bearer sk-or-mgmt',
      },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['spend']);
    // 5 / (5 + 16.3) = 23.5%
    expect(r.summary?.limits[0]).toMatchObject({
      label: 'Spend / Balance',
      used: 5,
      total: 16.3,
      percent: 23.5,
    });
    expect(new Date(r.summary?.limits[0].resetAt!).getUTCDate()).toBe(1);
  });

  it('aggregates key caps from the keys list (management key)', async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      {
        path: '/api/v1/analytics/query',
        body: { data: { data: [{ date__day: '2026-09-23', total_usage: 5 }] } },
      },
      { path: '/api/v1/credits', body: { data: { total_credits: 100, total_usage: 83.7 } } },
      {
        path: '/api/v1/keys',
        body: {
          data: [
            { name: 'usage', limit: null, limit_remaining: null, limit_reset: null },
            { name: 'leo', limit: 100, limit_remaining: 55.10687033, limit_reset: null },
          ],
        },
      },
    ]);

    const r = await fetchOpenrouterUsage();
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['spend', 'cap']);
    // 100 − 55.10687033 = $44.89 burned of the $100 cap → 44.9%
    expect(r.summary?.limits[1]).toMatchObject({
      label: 'Key Limit',
      kind: 'cap',
      used: 44.89,
      total: 100,
      percent: 44.9,
    });
    expect(r.summary?.limits[1].resetAt).toBeUndefined();
  });

  it('prefers the account-wide caps over the configured key\'s own cap', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    mockOr([
      { path: '/api/v1/credits', body: { data: { total_credits: 100, total_usage: 83.7 } } },
      {
        path: '/api/v1/keys',
        body: {
          data: [{ name: 'leo', limit: 100, limit_remaining: 55.10687033, limit_reset: null }],
        },
      },
      { path: '/api/v1/key', body: { data: KEY_DATA }, auth: `Bearer ${KEY}` },
    ]);

    const r = await fetchOpenrouterUsage();
    // the configured key's own 20/50 cap is superseded by the account's 44.89/100
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['spend', 'cap']);
    expect(r.summary?.limits[1]).toMatchObject({ used: 44.89, total: 100 });
  });

  it('maps a shared cap cadence onto the rollover, mixed cadences fall back to cap', async () => {
    process.env.OPENROUTER_MANAGEMENT_KEY = 'sk-or-mgmt';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T13:24:00Z'));
    const cases: Array<[
      resets: Array<string | null>,
      kind: string,
      resetAt: string | undefined,
    ]> = [
      [['monthly', 'monthly'], 'monthly', '2026-10-01T00:00:00.000Z'],
      [['monthly', 'daily'], 'cap', undefined],
    ];
    for (const [resets, kind, resetAt] of cases) {
      mockOr([
        {
          path: '/api/v1/keys',
          body: {
            data: resets.map((limit_reset, i) => ({
              name: `k${i}`,
              limit: 50,
              limit_remaining: 40,
              limit_reset,
            })),
          },
        },
      ]);
      const r = await fetchOpenrouterUsage();
      const cap = r.summary?.limits[0];
      expect(cap?.kind, `resets=${resets.join(',')}`).toBe(kind);
      expect(cap?.resetAt, `resets=${resets.join(',')}`).toBe(resetAt);
    }
  });

  it('merges two keys (Σspend, Σcap)', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_API_KEY_2 = 'sk-or-v1-two';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('Authorization') || '';
        const data =
          auth === `Bearer ${KEY}`
            ? KEY_DATA
            : { ...KEY_DATA, usage_monthly: 7.6, limit: 50, limit_remaining: 40 };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );

    const r = await fetchOpenrouterUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.accounts).toHaveLength(2);
    const spend = r.summary?.limits.find((l) => l.label === 'Month Spend');
    expect(spend).toMatchObject({ used: 20 });
    const cap = r.summary?.limits.find((l) => l.label === 'Key Limit');
    // (20 + 10) burned of (50 + 50) caps → 30%
    expect(cap).toMatchObject({ used: 30, total: 100, percent: 30 });
  });

  it('fails with a re-check hint on 401', async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    mockOr([{ path: '/api/v1/key', status: 401, body: { error: { message: 'nope' } } }]);

    const r = await fetchOpenrouterUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('OPENROUTER_API_KEY');
  });
});
