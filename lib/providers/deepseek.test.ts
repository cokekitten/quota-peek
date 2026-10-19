import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDeepseekUsage } from './deepseek';

const KEY = 'sk-test-ds';
const TOKEN = 'web-user-token';

afterEach(() => {
  vi.useRealTimers();
  for (const v of ['DEEPSEEK_API_KEY', 'DEEPSEEK_TOKEN', 'DEEPSEEK_BASE_URL']) {
    for (const n of [undefined, 2, 3]) delete process.env[n === undefined ? v : `${v}_${n}`];
  }
  vi.unstubAllGlobals();
});

// Mirrors the real /user/balance payload: total = granted + topped up.
const BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '69.50', granted_balance: '10.00', topped_up_balance: '59.50' },
  ],
};

/** Real payload has two axes: per-model `series` and per-function tool fees. */
const COST = (spend: number, toolFees = 0) => ({
  code: 0,
  data: {
    biz_data: {
      data: [
        {
          currency: 'CNY',
          series: [{ buckets: [{ time: '2026-09-01', cost: spend / 2 }, { time: '2026-09-15', cost: spend / 2 }] }],
          ...(toolFees
            ? {
                function_series: [
                  {
                    api_key: { name: 'search' },
                    model: 'tool-search',
                    buckets: [{ time: '2026-09-15', cost: toolFees }],
                  },
                ],
              }
            : {}),
        },
      ],
    },
  },
});

/** Route by URL+auth: the balance API takes the sk- key, the platform API the userToken. */
function mockDs(routes: Array<{ match: (url: string, auth: string) => boolean; status?: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization') || '';
      const route = routes.find((r) => r.match(url, auth));
      if (!route) throw new Error(`unexpected request ${url} auth=${auth}`);
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(body, { status: route.status ?? 200 });
    }),
  );
}

describe('fetchDeepseekUsage', () => {
  it('shows one 消费金额/余额 row: month spend over the complete balance', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      { match: (u, a) => u.endsWith('/user/balance') && a === `Bearer ${KEY}`, body: BALANCE },
      { match: (u, a) => u.includes('by_api_key/cost') && a === `Bearer ${TOKEN}`, body: COST(30.5) },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toHaveLength(1);
    // 余额 = 充值 59.5 + 赠金 10 = 69.5, and the pool share is
    // 30.5 / (30.5 + 69.5) = 30.5%
    expect(r.summary?.limits[0]).toMatchObject({
      kind: 'spend',
      label: 'Spend / Pool',
      percent: 30.5,
      used: 30.5,
      total: 69.5,
      unit: '¥',
      // the headline is a sum — the halves it came from are named
      detail: '¥59.50 top-up + ¥10.00 granted',
    });
    // the month window rolls over at the local month boundary (GMT+8 console)
    const reset = new Date(r.summary?.limits[0].resetAt!);
    expect(reset.getDate()).toBe(1);
    expect(reset.getHours()).toBe(0);
    expect(reset.getMonth()).toBe((new Date().getMonth() + 1) % 12);
    // …and it STARTED at this month's 1st, so the pace yardstick is the real
    // month length (28–31 d) instead of a 30-day stand-in
    const start = new Date(r.summary?.limits[0].paceStartAt!);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getMonth()).toBe(new Date().getMonth());
    expect(start.getTime()).toBeLessThan(reset.getTime());
  });

  it('computes the percent as the spend share of the money pool', async () => {
    const cases: Array<[spend: number, topup: number, percent: number]> = [
      [0, 100, 0], // nothing spent yet
      [100, 0, 100], // balance gone — the pool is fully burned
      [128, 100, 56.1], // spend/balance would say 128% — the pool share stays bounded
    ];
    for (const [spend, topup, percent] of cases) {
      process.env.DEEPSEEK_API_KEY = KEY;
      process.env.DEEPSEEK_TOKEN = TOKEN;
      mockDs([
        {
          match: (u) => u.endsWith('/user/balance'),
          body: {
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: String(topup), topped_up_balance: String(topup) }],
          },
        },
        { match: (u) => u.includes('by_api_key/cost'), body: COST(spend) },
      ]);

      const r = await fetchDeepseekUsage();
      expect(r.summary?.limits[0].percent, `spend=${spend} topup=${topup}`).toBe(percent);
    }
  });

  it('requests the calendar month in daily buckets (当月消费)', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T13:24:00Z'));
    mockDs([
      { match: (u) => u.endsWith('/user/balance'), body: BALANCE },
      { match: (u) => u.includes('by_api_key/cost'), body: COST(1) },
    ]);

    await fetchDeepseekUsage();
    const usageCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('by_api_key/cost'),
    );
    const q = new URL(String(usageCall![0])).searchParams;
    const start = Number(q.get('start')!);
    const end = Number(q.get('end')!);
    // 当月: the 1st's local midnight through the end of today (23 days in Sep)
    expect(new Date(start * 1000).getDate()).toBe(1);
    expect(end - start).toBe(new Date().getDate() * 86400);
    // both bounds must sit on the same local midnight (the API rejects otherwise)
    expect(start % 86400).toBe(end % 86400);
    vi.useRealTimers();
  });

  it('adds per-call tool fees from function_series to the month spend', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      { match: (u) => u.endsWith('/user/balance'), body: BALANCE },
      { match: (u) => u.includes('by_api_key/cost'), body: COST(30.5, 0.11) },
    ]);

    const r = await fetchDeepseekUsage();
    // The console's 消费金额 metric sums [...series, ...function_series];
    // model spend alone would report 30.5 and lose the 联网搜索 calls.
    expect(r.summary?.limits[0].used).toBeCloseTo(30.61, 6);
    // …and the pool share follows the larger numerator
    expect(r.summary?.limits[0].percent).toBeCloseTo((30.61 / (30.61 + 69.5)) * 100, 1);
  });

  it('falls back to the total balance when the payload does not split top-up', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      {
        match: (u) => u.endsWith('/user/balance'),
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '69.50' }] },
      },
      { match: (u) => u.includes('by_api_key/cost'), body: COST(30.5) },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.summary?.limits[0]).toMatchObject({ used: 30.5, total: 69.5 });
  });

  it('rebuilds the complete balance from 充值 + 赠金 when total_balance is absent', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      {
        match: (u) => u.endsWith('/user/balance'),
        body: {
          is_available: true,
          balance_infos: [{ currency: 'CNY', granted_balance: '10.00', topped_up_balance: '59.50' }],
        },
      },
      { match: (u) => u.includes('by_api_key/cost'), body: COST(30.5) },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.summary?.limits[0]).toMatchObject({
      used: 30.5,
      total: 69.5,
      detail: '¥59.50 top-up + ¥10.00 granted',
    });
  });

  it('degrades to one balance-only money row (完整余额) without a token', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    mockDs([{ match: (u) => u.endsWith('/user/balance'), body: BALANCE }]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toHaveLength(1);
    // the bare row states the same complete balance (充值 + 赠金), and its
    // note still names the halves
    expect(r.summary?.limits[0]).toMatchObject({
      kind: 'balance',
      percent: 0,
      used: 69.5,
      unit: '¥',
      detail: '¥59.50 top-up + ¥10.00 granted',
    });
  });

  it('keeps the balance card when the usage token is rejected, with a note', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      { match: (u) => u.endsWith('/user/balance'), body: BALANCE },
      {
        match: (u) => u.includes('by_api_key/cost'),
        status: 401,
        body: { code: 40003, msg: 'invalid token' },
      },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toHaveLength(1);
    const balance = r.summary?.limits[0];
    expect(balance?.kind).toBe('balance');
    expect(balance?.detail).toContain('spend n/a');
    expect(balance?.detail).toContain('userToken');
  });

  it('flags insufficient balance from is_available=false', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    mockDs([
      {
        match: (u) => u.endsWith('/user/balance'),
        body: { is_available: false, balance_infos: BALANCE.balance_infos },
      },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits[0]?.detail).toContain('insufficient for API calls');
  });

  it('fails offline on a balance 401', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    mockDs([
      { match: (u) => u.endsWith('/user/balance'), status: 401, body: { msg: 'Authentication Fails' } },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  it('merges two accounts exactly (Σspend / Σbalance)', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    process.env.DEEPSEEK_API_KEY_2 = 'sk-2';
    process.env.DEEPSEEK_TOKEN_2 = 'tok-2';
    mockDs([
      {
        match: (u, a) => u.endsWith('/user/balance') && a === `Bearer ${KEY}`,
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '40', topped_up_balance: '40' }] },
      },
      {
        match: (u, a) => u.endsWith('/user/balance') && a === 'Bearer sk-2',
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '60', topped_up_balance: '60' }] },
      },
      { match: (u, a) => u.includes('by_api_key/cost') && a === `Bearer ${TOKEN}`, body: COST(100) },
      { match: (u, a) => u.includes('by_api_key/cost') && a === 'Bearer tok-2', body: COST(28) },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.accounts).toHaveLength(2);
    const spend = r.summary?.limits.find((l) => l.kind === 'spend');
    // Σspend = 128, Σbalance = 100 → 128/228 = 56% pool share (bounded)
    expect(spend).toMatchObject({ used: 128, total: 100, percent: 56 });
  });

  it('handles numeric-string balances and zero spend', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      {
        match: (u) => u.endsWith('/user/balance'),
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 100 }] },
      },
      { match: (u) => u.includes('by_api_key/cost'), body: COST(0) },
    ]);

    const r = await fetchDeepseekUsage();
    const spend = r.summary?.limits.find((l) => l.kind === 'spend');
    expect(spend).toMatchObject({ percent: 0, used: 0, total: 100 });
  });
});
