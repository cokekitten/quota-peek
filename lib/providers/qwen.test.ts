import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSummary, fetchQwenUsage, isConfigured, normalizeCookie, ratio, toIso } from './qwen';

const COOKIE = 'cna=abc123; session=secret-value; sec_token=cookie-token';

afterEach(() => {
  delete process.env.QWEN_COOKIE;
  delete process.env.QWEN_COOKIE_2;
  delete process.env.QWEN_SEC_TOKEN;
  vi.unstubAllGlobals();
});

interface MockOptions {
  usage?: unknown;
  quota?: unknown;
  subscription?: unknown;
  quotaStatus?: number;
  usageError?: unknown;
}

function envelope(data: unknown) {
  // Real 2026-11 shape: DataV2.data -> { ret, data: { code, msg, success, data } }.
  return {
    code: '200',
    successResponse: true,
    data: {
      DataV2: {
        data: {
          success: true,
          ret: ['SUCCESS::接口调用成功'],
          data: { msg: 'Success.', code: 'SUCCESS', success: true, data },
        },
      },
    },
  };
}

function mockGateway(opts: MockOptions = {}) {
  const calls: Array<{ api: string; secToken: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/tool/user/info.json')) {
        return new Response(JSON.stringify({ data: { secToken: 'fresh-token' } }), { status: 200 });
      }
      const parsed = new URL(url);
      const api = parsed.searchParams.get('api') || '';
      const body = new URLSearchParams(String(init?.body || ''));
      calls.push({ api, secToken: body.get('sec_token') });
      if (opts.usageError) return new Response(JSON.stringify(opts.usageError), { status: 200 });
      if (api.endsWith('/usage')) {
        return new Response(JSON.stringify(envelope(opts.usage ?? {})), { status: 200 });
      }
      if (api.endsWith('/quota-config')) {
        if (opts.quotaStatus) {
          return new Response('upstream timeout', { status: opts.quotaStatus });
        }
        return new Response(JSON.stringify(envelope(opts.quota ?? {})), { status: 200 });
      }
      if (api.endsWith('/subscription')) {
        return new Response(JSON.stringify(envelope(opts.subscription ?? {})), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

describe('fetchQwenUsage', () => {
  it('reads the monthly window with its quota denominator and plan name', async () => {
    process.env.QWEN_COOKIE = COOKIE;
    const calls = mockGateway({
      usage: { per1MonthPercentage: 0.349, per1MonthResetTime: 1790000000000 },
      quota: { standard: { monthly: 10000, five_hour: 3000 } },
      subscription: { specCode: 'standard', remainingDays: 12 },
    });

    const r = await fetchQwenUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.planLabel).toBe('Standard');
    expect(r.summary?.planKey).toBe('standard');
    expect(r.summary?.limits).toEqual([
      expect.objectContaining({
        kind: 'monthly',
        label: 'Monthly',
        percent: 34.9,
        used: 3490,
        total: 10000,
        unit: 'Credits',
        resetAt: new Date(1790000000000).toISOString(),
      }),
    ]);
    // The sec_token comes from tool/user/info.json; the cna cookie rides along
    // in cornerstoneParam (the gateway's anonymous id).
    expect(calls.every((c) => c.secToken === 'fresh-token')).toBe(true);
    // The cookie itself must never appear in the result payload.
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });

  it('keeps the official ratio when quota-config times out', async () => {
    process.env.QWEN_COOKIE = COOKIE;
    mockGateway({
      usage: { per1MonthPercentage: 0.5, per1MonthResetTime: '2026-12-01 00:00:00' },
      quotaStatus: 500,
      subscription: { specCode: 'pro' },
    });

    const r = await fetchQwenUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.planLabel).toBe('Pro');
    const monthly = r.summary?.limits?.[0];
    expect(monthly).toMatchObject({ kind: 'monthly', percent: 50 });
    expect(monthly?.total).toBeUndefined();
    expect(monthly?.used).toBeUndefined();
    expect(monthly?.resetAt).toBe('2026-11-30T16:00:00.000Z');
  });

  it('supports the legacy weekly shape', async () => {
    process.env.QWEN_COOKIE = COOKIE;
    mockGateway({
      usage: { per1WeekPercentage: 0.25, per1WeekResetTime: 1790000000000 },
      quota: { pro: { weekly: 4000, five_hour: 1000 } },
      subscription: { specCode: 'pro' },
    });

    const r = await fetchQwenUsage();
    expect(r.summary?.limits).toEqual([
      expect.objectContaining({ kind: 'weekly', percent: 25, used: 1000, total: 4000 }),
    ]);
  });

  it('reports an expired session without echoing the cookie', async () => {
    process.env.QWEN_COOKIE = COOKIE;
    mockGateway({
      usageError: {
        data: { errorCode: 'BailianGateway.Login.NotLogined', errorMsg: 'login required' },
      },
    });

    const r = await fetchQwenUsage();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('login required');
    expect(r.error).not.toContain('secret-value');
  });

  it('is configured only when a cookie is present', () => {
    expect(isConfigured()).toBe(false);
    process.env.QWEN_COOKIE = COOKIE;
    expect(isConfigured()).toBe(true);
    delete process.env.QWEN_COOKIE;
    process.env.QWEN_COOKIE_2 = COOKIE;
    expect(isConfigured()).toBe(true);
  });
});

describe('buildSummary', () => {
  it('does not invent a window from quota-config alone', () => {
    const s = buildSummary({}, { standard: { monthly: 10000, five_hour: 3000 } }, { specCode: 'standard' });
    expect(s.limits).toEqual([]);
    expect(s.planLabel).toBe('Standard');
  });

  it('orders monthly before weekly before 5h', () => {
    const s = buildSummary(
      { per5HourPercentage: 0.1, per1WeekPercentage: 0.2, per1MonthPercentage: 0.3 },
      { lite: { monthly: 100, weekly: 50, five_hour: 10 } },
      { specCode: 'lite' },
    );
    expect(s.limits.map((l) => l.kind)).toEqual(['monthly', 'weekly', '5h']);
  });

  it('clamps ratios and leaves unknown specs unlabelled', () => {
    expect(ratio(1.4)).toBe(1);
    expect(ratio(-0.2)).toBe(0);
    expect(ratio('0.75')).toBe(0.75);
    expect(ratio(undefined)).toBeUndefined();
    const s = buildSummary({ per1MonthPercentage: 2 }, null, null);
    expect(s.planLabel).toBeUndefined();
    expect(s.limits[0].percent).toBe(100);
  });
});

describe('helpers', () => {
  it('normalizes a pasted Cookie header', () => {
    expect(normalizeCookie('Cookie: a=1;\r\nb=2')).toBe('a=1; b=2');
    expect(normalizeCookie('"a=1; b=2"')).toBe('a=1; b=2');
  });

  it('parses epoch seconds, epoch ms and +08:00 wall clocks', () => {
    expect(toIso(1790000000)).toBe(new Date(1790000000000).toISOString());
    expect(toIso('1790000000000')).toBe(new Date(1790000000000).toISOString());
    expect(toIso('2026-12-01 00:00:00')).toBe('2026-11-30T16:00:00.000Z');
    expect(toIso(0)).toBeUndefined();
    expect(toIso('')).toBeUndefined();
  });
});
