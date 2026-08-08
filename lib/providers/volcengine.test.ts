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
  setEnv('VOLC_ACCESS_KEY_2');
  setEnv('VOLC_SECRET_KEY_2');
  setEnv('VOLC_PLAN_LABEL');
  setEnv('VOLC_PLAN_LABEL_2');
  vi.unstubAllGlobals();
});

function json200(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mock global fetch, dispatching on the Action query param. */
function mockByAction(map: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const action = new URL(url).searchParams.get('Action')!;
      if (!(action in map)) throw new Error(`unexpected action ${action}`);
      return json200(map[action]);
    }),
  );
}

const CODING_PLAN_RESULT = {
  ResponseMetadata: { RequestId: 'req-1', Action: 'GetCodingPlanUsage' },
  Result: {
    Status: 'Running',
    UpdateTimestamp: 1786180864,
    QuotaUsage: [
      { Level: 'session', Percent: 1.4573, ResetTimestamp: 1786187179, Cap: 100 },
      { Level: 'weekly', Percent: 16.0913, ResetTimestamp: 1786291200, Cap: 100 },
      { Level: 'monthly', Percent: 8.0456, ResetTimestamp: 1788537599, Cap: 100 },
    ],
  },
};

const AFP_RESULT = {
  ResponseMetadata: { RequestId: 'req-2', Action: 'GetAFPUsage' },
  Result: {
    PlanType: 'Medium',
    AFPFiveHour: { Quota: 1200, Used: 300, SubscribeTime: 1, ResetTime: 1786200000 },
    AFPDaily: { Quota: 4000, Used: 100, SubscribeTime: 1, ResetTime: 1786200000 },
    AFPWeekly: { Quota: 9000, Used: 4500, SubscribeTime: 1, ResetTime: 1786800000 },
    AFPMonthly: { Quota: 30000, Used: 600, SubscribeTime: 1, ResetTime: 1788800000 },
  },
};

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

  it('maps GetCodingPlanUsage session/weekly windows (percent-scale)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    mockByAction({ GetCodingPlanUsage: CODING_PLAN_RESULT });

    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Coding Plan');
    const fiveHour = result.summary?.limits.find((l) => l.kind === '5h')!;
    expect(fiveHour.percent).toBe(1);
    expect(fiveHour.resetAt).toBe(new Date(1786187179 * 1000).toISOString());
    const weekly = result.summary?.limits.find((l) => l.kind === 'weekly')!;
    expect(weekly.percent).toBe(16);
    const monthly = result.summary?.limits.find((l) => l.kind === 'monthly')!;
    expect(monthly.percent).toBe(8);
    expect(monthly.resetAt).toBe(new Date(1788537599 * 1000).toISOString());
  });

  it('honors VOLC_PLAN_LABEL as the tier name (the API returns none)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    setEnv('VOLC_PLAN_LABEL', 'Pro');
    mockByAction({ GetCodingPlanUsage: CODING_PLAN_RESULT });
    const result = await fetchVolcengineUsage();
    expect(result.summary?.planLabel).toBe('Pro');
  });

  it('falls back to GetAFPUsage when the plan predates GetCodingPlanUsage', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    mockByAction({
      GetCodingPlanUsage: {
        ResponseMetadata: {
          Error: { Code: 'InvalidActionOrVersion', Message: 'no such operation' },
        },
      },
      GetAFPUsage: AFP_RESULT,
    });

    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Medium');
    const fiveHour = result.summary?.limits.find((l) => l.kind === '5h')!;
    expect(fiveHour).toMatchObject({ percent: 25, used: 300, total: 1200 });
    const weekly = result.summary?.limits.find((l) => l.kind === 'weekly')!;
    expect(weekly).toMatchObject({ percent: 50, used: 4500, total: 9000 });
    const monthly = result.summary?.limits.find((l) => l.kind === 'monthly')!;
    expect(monthly).toMatchObject({ percent: 2, used: 600, total: 30000 });
    expect(result.summary?.daily).toMatchObject({ Quota: 4000 });
  });

  it('treats empty results on both APIs as "no subscription" (offline)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    mockByAction({
      GetCodingPlanUsage: { ResponseMetadata: {}, Result: { Status: '', QuotaUsage: [] } },
      GetAFPUsage: {
        ResponseMetadata: {},
        Result: { PlanType: '', AFPFiveHour: { Quota: 0, Used: 0 } },
      },
    });
    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No Coding Plan');
  });

  it('merges multiple coding-plan accounts as a flagged mean (percent-scale)', async () => {
    setEnv('VOLC_ACCESS_KEY', AK);
    setEnv('VOLC_SECRET_KEY', SK);
    setEnv('VOLC_ACCESS_KEY_2', AK + '2');
    setEnv('VOLC_SECRET_KEY_2', SK + '2');
    mockByAction({
      GetCodingPlanUsage: {
        ResponseMetadata: {},
        Result: {
          Status: 'Running',
          QuotaUsage: [
            { Level: 'session', Percent: 20, ResetTimestamp: 1786187179 },
            { Level: 'weekly', Percent: 40, ResetTimestamp: 1786291200 },
          ],
        },
      },
    });

    const result = await fetchVolcengineUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.accounts).toHaveLength(2);
    const fiveHour = result.summary?.limits.find((l) => l.kind === '5h')!;
    expect(fiveHour.percent).toBe(20);
    expect(fiveHour.estimated).toBe(true); // percent-scale Cap=100 → not exact
  });
});
