import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVolcengineUsage, signVolcRequest } from './volcengine';

const AK = 'AKLTdGVzdA';
const SK = 'c2stdGVzdA==';

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv('VOLC_ACCESS_KEY');
  setEnv('VOLC_SECRET_KEY');
  vi.unstubAllGlobals();
});

function volcResponse(result: unknown) {
  return new Response(
    JSON.stringify({
      ResponseMetadata: { RequestId: 'req-1', Action: 'GetAFPUsage' },
      Result: result,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('signVolcRequest', () => {
  it('produces the golden V4 signature (verified live against the API)', () => {
    const headers = signVolcRequest({
      accessKey: 'AK_TEST',
      secretKey: 'SK_TEST',
      host: 'ark.cn-beijing.volcengineapi.com',
      region: 'cn-beijing',
      service: 'ark',
      action: 'GetAFPUsage',
      version: '2024-01-01',
      body: '{}',
      now: new Date('2026-08-08T10:20:30Z'),
    });
    expect(headers['X-Date']).toBe('20260808T102030Z');
    expect(headers['X-Content-Sha256']).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(headers.Authorization).toBe(
      'HMAC-SHA256 Credential=AK_TEST/20260808/cn-beijing/ark/request, ' +
        'SignedHeaders=host;x-content-sha256;x-date, ' +
        'Signature=415fc87cd008048b2995d6621317fd546a75bfd43eb0c26f3ab0f794acf97be6',
    );
  });
});

describe('fetchVolcengineUsage', () => {
  it('reports missing credentials as an offline card', async () => {
    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('VOLC_ACCESS_KEY');
  });

  it('maps PlanType + 5h/weekly windows with absolute numbers', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        volcResponse({
          PlanType: 'Medium',
          AFPFiveHour: { Quota: 1200, Used: 300, SubscribeTime: 1, ResetTime: 1786200000 },
          AFPDaily: { Quota: 4000, Used: 100, SubscribeTime: 1, ResetTime: 1786200000 },
          AFPWeekly: { Quota: 9000, Used: 4500, SubscribeTime: 1, ResetTime: 1786800000 },
          AFPMonthly: { Quota: 30000, Used: 600, SubscribeTime: 1, ResetTime: 1788800000 },
        }),
      ),
    );

    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Medium');
    const fiveHour = result.summary?.limits.find((l) => l.kind === '5h')!;
    expect(fiveHour).toMatchObject({ percent: 25, used: 300, total: 1200 });
    expect(fiveHour.resetAt).toBe(new Date(1786200000 * 1000).toISOString());
    const weekly = result.summary?.limits.find((l) => l.kind === 'weekly')!;
    expect(weekly).toMatchObject({ percent: 50, used: 4500, total: 9000 });
    // Daily/monthly ride along for future UI.
    expect(result.summary?.daily).toMatchObject({ Quota: 4000 });
    expect(result.summary?.monthly).toMatchObject({ Quota: 30000 });
  });

  it('treats an empty PlanType as "no subscription" (offline)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        volcResponse({
          PlanType: '',
          AFPFiveHour: { Quota: 0, Used: 0, SubscribeTime: 0, ResetTime: 0 },
          AFPWeekly: { Quota: 0, Used: 0, SubscribeTime: 0, ResetTime: 0 },
        }),
      ),
    );
    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No Coding Plan');
  });

  it('merges multiple accounts via the shared layer (exact weighted)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    setEnv('VOLC_ACCESS_KEY_2', AK + '2');
    setEnv('VOLC_SECRET_KEY_2', SK + '2');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        volcResponse({
          PlanType: 'Small',
          AFPFiveHour: { Quota: 100, Used: 50, SubscribeTime: 1, ResetTime: 1786200000 },
          AFPWeekly: { Quota: 1000, Used: 100, SubscribeTime: 1, ResetTime: 1786800000 },
        }),
      ),
    );
    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.accounts).toHaveLength(2);
    // Two identical accounts → merged 5h = 100 used / 200 total = 50%.
    const fiveHour = result.summary?.limits.find((l) => l.kind === '5h')!;
    expect(fiveHour).toMatchObject({ percent: 50, used: 100, total: 200 });
    expect(fiveHour.estimated).toBeUndefined();
    setEnv('VOLC_ACCESS_KEY_2');
    setEnv('VOLC_SECRET_KEY_2');
  });
});
