import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDeepseekUsage } from './deepseek';

const KEY = 'sk-test-ds';
const TOKEN = 'web-user-token';

afterEach(() => {
  for (const v of ['DEEPSEEK_API_KEY', 'DEEPSEEK_TOKEN', 'DEEPSEEK_BASE_URL']) {
    for (const n of [undefined, 2, 3]) delete process.env[n === undefined ? v : `${v}_${n}`];
  }
  vi.unstubAllGlobals();
});

const BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '69.50', granted_balance: '10.00', topped_up_balance: '59.50' },
  ],
};

const COST = (spend: number) => ({
  code: 0,
  data: {
    biz_data: {
      data: [
        {
          currency: 'CNY',
          series: [{ buckets: [{ time: '2026-09-01', cost: spend / 2 }, { time: '2026-09-15', cost: spend / 2 }] }],
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
  it('shows month spend + balance with token and key', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    mockDs([
      { match: (u, a) => u.endsWith('/user/balance') && a === `Bearer ${KEY}`, body: BALANCE },
      {
        match: (u, a) => u.includes('by_api_key/cost') && a === `Bearer ${TOKEN}`,
        body: COST(30.5),
      },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    const spend = r.summary?.limits.find((l) => l.kind === 'spend');
    const balance = r.summary?.limits.find((l) => l.kind === 'balance');
    // pool = 30.5 + 69.5 = 100 → 30.5%
    expect(spend).toMatchObject({ percent: 30.5, used: 30.5, total: 100, unit: '¥' });
    expect(spend?.resetAt).toBeUndefined();
    expect(balance).toMatchObject({ percent: 0, used: 69.5, unit: '¥' });
    expect(balance?.detail).toContain('granted ¥10');
    expect(balance?.detail).toContain('top-up ¥59.5');
  });

  it('degrades to balance-only without a token', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    mockDs([
      { match: (u) => u.endsWith('/user/balance'), body: BALANCE },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toHaveLength(1);
    expect(r.summary?.limits[0]).toMatchObject({ kind: 'balance', used: 69.5, percent: 0 });
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

  it('merges two accounts exactly (Σspend / Σpool)', async () => {
    process.env.DEEPSEEK_API_KEY = KEY;
    process.env.DEEPSEEK_TOKEN = TOKEN;
    process.env.DEEPSEEK_API_KEY_2 = 'sk-2';
    process.env.DEEPSEEK_TOKEN_2 = 'tok-2';
    mockDs([
      {
        match: (u, a) => u.endsWith('/user/balance') && a === `Bearer ${KEY}`,
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '69.5' }] },
      },
      {
        match: (u, a) => u.endsWith('/user/balance') && a === 'Bearer sk-2',
        body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0' }] },
      },
      { match: (u, a) => u.includes('by_api_key/cost') && a === `Bearer ${TOKEN}`, body: COST(30.5) },
      { match: (u, a) => u.includes('by_api_key/cost') && a === 'Bearer tok-2', body: COST(9.5) },
    ]);

    const r = await fetchDeepseekUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.accounts).toHaveLength(2);
    const spend = r.summary?.limits.find((l) => l.kind === 'spend');
    // Σused = 40, Σpool = 30.5+69.5 + 9.5+0 = 109.5 → 36.5% → merge rounds to integer
    expect(spend).toMatchObject({ used: 40, total: 109.5, percent: 37 });
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
