import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchMimoUsage } from './mimo';

const COOKIE = 'api-platform_serviceToken="tok=="';
const SEED = { userId: '12345', passToken: 'PT-abcdef' };

afterEach(() => {
  for (const v of ['MIMO_COOKIE', 'MIMO_USER_ID', 'MIMO_PASS_TOKEN', 'MIMO_BASE_URL', 'MIMO_SESSION_FILE']) {
    for (const n of [undefined, 2]) delete process.env[n === undefined ? v : `${v}_${n}`];
  }
  vi.unstubAllGlobals();
});

const USAGE = {
  code: 0,
  data: {
    usage: {
      percent: 0.25,
      items: [
        { name: 'plan_total_token', used: 500_000_000, limit: 2_000_000_000, percent: 0.25 },
        { name: 'compensation_total_token', used: 1_000_000, limit: 10_000_000, percent: 0.1 },
      ],
    },
    monthUsage: {
      percent: 0.25,
      items: [{ name: 'plan_total_token', used: 500_000_000, limit: 2_000_000_000, percent: 0.25 }],
    },
  },
};

const BALANCE = {
  code: 0,
  data: { balance: '12.34', cashBalance: '10.00', giftBalance: '2.34', currency: 'CNY' },
};

// Mirrors a real tokenPlan/detail response (plan-manage page: "有效期至 … (UTC)").
const DETAIL = {
  code: 0,
  message: '',
  data: {
    planCode: 'max',
    planName: 'Max',
    currentPeriodEnd: '2026-10-21 23:59:59',
    expired: false,
    enableAutoRenew: true,
    autoRenewDiscount: null,
    hasAutoRenewSubscribed: true,
    clawEnabled: false,
    clawPeriodEnd: null,
    clawPurchased: false,
  },
};

function mockMimo(
  routes: Array<{ path: string; status?: number; body: unknown; cookie?: string }>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const route = routes.find((r) => url.includes(r.path));
      if (!route) throw new Error(`unexpected request ${url}`);
      if (route.cookie) {
        const cookie = new Headers(init?.headers).get('Cookie') || '';
        if (cookie !== route.cookie) throw new Error(`cookie mismatch: ${cookie}`);
      }
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(body, { status: route.status ?? 200 });
    }),
  );
}

describe('fetchMimoUsage', () => {
  it('renders compensation, monthly and balance rows (Token Plan is the same counter as Monthly)', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      { path: '/api/v1/tokenPlan/usage', body: USAGE, cookie: COOKIE },
      { path: '/api/v1/tokenPlan/detail', body: DETAIL, cookie: COOKIE },
      { path: '/api/v1/balance', body: BALANCE, cookie: COOKIE },
    ]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    // detail's planName feeds the card header tag (otherwise it says "live")
    expect(r.summary?.planLabel).toBe('Max');
    const kinds = r.summary?.limits.map((l) => l.kind);
    expect(kinds).toEqual(['comp', 'monthly', 'balance']);

    expect(r.summary?.limits[0]).toMatchObject({ kind: 'comp', percent: 10 });
    const monthly = r.summary?.limits[1];
    expect(monthly).toMatchObject({ kind: 'monthly', percent: 25, used: 500_000_000, total: 2_000_000_000, unit: 'cr' });
    // currentPeriodEnd is UTC (the console labels it "(UTC)") — 23:59:59Z, not local.
    expect(monthly?.resetAt).toBe('2026-10-21T23:59:59.000Z');
    expect(r.summary?.limits[2]).toMatchObject({ kind: 'balance', used: 12.34, unit: '¥' });
    // money rows state the amount once — no cash/gift re-run of the total
    expect(r.summary?.limits[2]?.detail).toBeUndefined();
  });

  it('falls back to the Token Plan row when the usage payload has no month item', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      {
        path: '/api/v1/tokenPlan/usage',
        body: {
          code: 0,
          data: {
            usage: {
              items: [{ name: 'plan_total_token', used: 500_000_000, limit: 2_000_000_000, percent: 0.25 }],
            },
          },
        },
      },
    ]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['plan']);
  });

  it('sends console headers (referer, x-timezone, UA) with the cookie', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    let seen: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(JSON.stringify(USAGE), { status: 200 });
      }),
    );

    await fetchMimoUsage();
    expect(seen?.get('Cookie')).toBe(COOKIE);
    expect(seen?.get('Referer')).toBe('https://platform.xiaomimimo.com/console/plan-manage');
    expect(seen?.get('x-timezone')).toBeTruthy();
    expect(seen?.get('User-Agent')).toContain('Mozilla');
  });

  it('skips the compensation row when it has no quota, tolerates missing balance API', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      {
        path: '/api/v1/tokenPlan/usage',
        body: {
          code: 0,
          data: {
            usage: {
              items: [
                { name: 'plan_total_token', used: 1, limit: 100, percent: 0.01 },
                { name: 'compensation_total_token', used: 0, limit: 0 },
              ],
            },
            monthUsage: { items: [{ used: 1, limit: 100 }] },
          },
        },
      },
      { path: '/api/v1/balance', status: 404, body: 'not found' },
    ]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    const kinds = r.summary?.limits.map((l) => l.kind);
    expect(kinds).toEqual(['monthly']);
  });

  it('falls back to the API percent when limit is missing', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      {
        path: '/api/v1/tokenPlan/usage',
        body: {
          code: 0,
          data: {
            usage: { items: [{ name: 'plan_total_token', percent: '0.4' }] },
            monthUsage: { items: [{ percent: 0.4 }] },
          },
        },
      },
    ]);

    const r = await fetchMimoUsage();
    const monthly = r.summary?.limits.find((l) => l.kind === 'monthly');
    expect(monthly).toMatchObject({ percent: 40 });
    expect(monthly?.used).toBeUndefined();
    expect(monthly?.total).toBeUndefined();
  });

  it('leaves Monthly without a countdown when tokenPlan/detail is unavailable', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([{ path: '/api/v1/tokenPlan/usage', body: USAGE, cookie: COOKIE }]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    const monthly = r.summary?.limits.find((l) => l.kind === 'monthly');
    expect(monthly?.resetAt).toBeUndefined();
    expect(r.summary?.planLabel).toBeUndefined();
  });

  it('ignores a malformed currentPeriodEnd', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      { path: '/api/v1/tokenPlan/usage', body: USAGE, cookie: COOKIE },
      {
        path: '/api/v1/tokenPlan/detail',
        body: { code: 0, data: { ...DETAIL.data, currentPeriodEnd: 'soon™' } },
        cookie: COOKIE,
      },
    ]);

    const r = await fetchMimoUsage();
    const monthly = r.summary?.limits.find((l) => l.kind === 'monthly');
    expect(monthly?.resetAt).toBeUndefined();
  });

  it('drops a currentPeriodEnd already in the past', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      { path: '/api/v1/tokenPlan/usage', body: USAGE, cookie: COOKIE },
      {
        path: '/api/v1/tokenPlan/detail',
        body: { code: 0, data: { ...DETAIL.data, currentPeriodEnd: '2020-01-01 00:00:00', expired: true } },
        cookie: COOKIE,
      },
    ]);

    const r = await fetchMimoUsage();
    const monthly = r.summary?.limits.find((l) => l.kind === 'monthly');
    expect(monthly?.resetAt).toBeUndefined();
  });

  it('fails with a re-paste hint on 401', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([{ path: '/api/v1/tokenPlan/usage', status: 401, body: '' }]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('re-paste');
  });

  it('fails on a non-auth error code', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    mockMimo([
      { path: '/api/v1/tokenPlan/usage', body: { code: 500, message: 'internal boom' } },
    ]);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('internal boom');
    expect(r.error).toContain('Usage query failed');
  });

  it('merges two cookie accounts exactly by kind', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    process.env.MIMO_COOKIE_2 = 'api-platform_serviceToken="tok2=="';
    const usage2 = {
      code: 0,
      data: {
        usage: { items: [{ name: 'plan_total_token', used: 1_000_000_000, limit: 2_000_000_000 }] },
        monthUsage: { items: [{ used: 1_000_000_000, limit: 2_000_000_000 }] },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const cookie = new Headers(init?.headers).get('Cookie') || '';
        if (url.includes('tokenPlan/usage')) {
          return new Response(JSON.stringify(cookie.includes('tok2') ? usage2 : USAGE), { status: 200 });
        }
        if (url.includes('/api/v1/balance')) {
          return new Response(JSON.stringify(cookie.includes('tok2') ? { code: 0, data: { balance: '0' } } : BALANCE), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.accounts).toHaveLength(2);
    const monthly = r.summary?.limits.find((l) => l.kind === 'monthly');
    // (0.5B + 1B) / (2B + 2B) = 37.5% → merge rounds to integer
    expect(monthly).toMatchObject({ used: 1_500_000_000, total: 4_000_000_000, percent: 38 });
    // balance row: only account 1 has money; merge keeps it visible
    const balance = r.summary?.limits.find((l) => l.kind === 'balance');
    expect(balance?.used).toBe(12.34);
  });
});

describe('SSO auto-refresh (seed path)', () => {
  const LOGIN_URL =
    'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&callback=https%3A%2F%2Fplatform.xiaomimimo.com%2Fsts%3Ffoo%3Dbar&_sign=x';
  const AUTH_PAYLOAD = {
    code: 0,
    location: 'https://platform.xiaomimimo.com/sts?ticket=t1',
    nonce: 'n0nce',
    ssecurity: 's3cr3t',
    userId: '12345',
    passToken: 'PT-rotated',
  };
  const STS_COOKIES = [
    'api-platform_serviceToken=NEW; Path=/; Domain=.platform.xiaomimimo.com',
    'api-platform_slh=slh1; Path=/; Domain=.platform.xiaomimimo.com',
    'api-platform_ph=ph1; Path=/; Domain=.platform.xiaomimimo.com',
    'userId=12345; Path=/; Domain=.platform.xiaomimimo.com',
  ];

  function ssoMock(opts: {
    usageWithOldCookie: { status: number; body?: string };
    usageWithNewCookie?: { status: number; body?: string };
    authStatus?: number;
    authBody?: boolean;
  }) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get('Cookie') || '';
      if (url.includes('/api/v1/tokenPlan/usage')) {
        const hit = (cookie.includes('NEW') ? opts.usageWithNewCookie : opts.usageWithOldCookie)!;
        return new Response(hit.body ?? '', { status: hit.status });
      }
      if (url.includes('/api/v1/genLoginUrl')) {
        return new Response(JSON.stringify({ loginUrl: LOGIN_URL }), { status: 200 });
      }
      if (url.startsWith('https://account.xiaomi.com/pass/serviceLogin')) {
        const body = opts.authBody ? JSON.stringify({ code: 70001 }) : JSON.stringify(AUTH_PAYLOAD);
        return new Response(`&&&START&&&${body}`, {
          status: opts.authStatus ?? 200,
        });
      }
      if (url.includes('/sts')) {
        return new Response('', {
          status: 302,
          headers: [
            ['set-cookie', STS_COOKIES[0]],
            ['set-cookie', STS_COOKIES[1]],
            ['set-cookie', STS_COOKIES[2]],
            ['set-cookie', STS_COOKIES[3]],
            ['location', 'https://platform.xiaomimimo.com/console/plan-manage'],
          ],
        });
      }
      if (url.includes('/api/v1/userProfile')) {
        return new Response(JSON.stringify({ code: 0, data: { userId: '12345' } }), { status: 200 });
      }
      if (url.includes('/api/v1/balance')) {
        return new Response(JSON.stringify({ code: 0, data: { balance: '0' } }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it('renews an expired cookie via userId+passToken and retries usage', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-mimo-'));
    process.env.MIMO_SESSION_FILE = path.join(dir, 'session.json');
    process.env.MIMO_USER_ID = SEED.userId;
    process.env.MIMO_PASS_TOKEN = SEED.passToken;
    process.env.MIMO_COOKIE = COOKIE;
    const fn = ssoMock({
      usageWithOldCookie: { status: 401 },
      usageWithNewCookie: { status: 200, body: JSON.stringify(USAGE) },
    });
    vi.stubGlobal('fetch', fn);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits.find((l) => l.kind === 'monthly')).toMatchObject({ kind: 'monthly', percent: 25 });
    // the SSO exchange used the seed cookies …
    const authCall = fn.mock.calls.find((c) => String(c[0]).includes('serviceLogin'));
    expect(new Headers((authCall?.[1] as RequestInit | undefined)?.headers).get('Cookie')).toBe(
      `userId=${SEED.userId}; passToken=${SEED.passToken}`,
    );
    // … signed the STS URL …
    const stsCall = fn.mock.calls.find((c) => String(c[0]).includes('/sts'));
    expect(String(stsCall?.[0])).toContain('clientSign=');
    // … and the session cache persists the rotated seed + fresh cookie
    const saved = JSON.parse(readFileSync(process.env.MIMO_SESSION_FILE!, 'utf8')) as {
      accounts: Record<string, { platformCookie: string; passToken: string }>;
    };
    const entry = Object.values(saved.accounts)[0];
    expect(entry.platformCookie).toContain('api-platform_serviceToken=NEW');
    expect(entry.passToken).toBe('PT-rotated');
    rmSync(dir, { recursive: true, force: true });
  });

  it('bootstraps from the seed alone (no MIMO_COOKIE) via a cached session', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-mimo-'));
    process.env.MIMO_SESSION_FILE = path.join(dir, 'session.json');
    process.env.MIMO_USER_ID = SEED.userId;
    process.env.MIMO_PASS_TOKEN = SEED.passToken;
    const fn = ssoMock({
      usageWithOldCookie: { status: 401 }, // cached cookie (none) → refresh first
      usageWithNewCookie: { status: 200, body: JSON.stringify(USAGE) },
    });
    vi.stubGlobal('fetch', fn);

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits.map((l) => l.kind)).toEqual(['comp', 'monthly']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails with a re-paste hint when the seed itself is dead', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-mimo-'));
    process.env.MIMO_SESSION_FILE = path.join(dir, 'session.json');
    process.env.MIMO_USER_ID = SEED.userId;
    process.env.MIMO_PASS_TOKEN = SEED.passToken;
    process.env.MIMO_COOKIE = COOKIE;
    vi.stubGlobal(
      'fetch',
      ssoMock({ usageWithOldCookie: { status: 401 }, authBody: true }),
    );

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('re-paste MIMO_USER_ID/MIMO_PASS_TOKEN');
    rmSync(dir, { recursive: true, force: true });
  });

  it('without a seed, an expired cookie fails with the seed hint', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    vi.stubGlobal('fetch', ssoMock({ usageWithOldCookie: { status: 401 } }));

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MIMO_USER_ID');
  });

  it('treats a 302 to the login page as an auth failure', async () => {
    process.env.MIMO_COOKIE = COOKIE;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' },
        }),
      ),
    );

    const r = await fetchMimoUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Cookie expired');
  });
});
