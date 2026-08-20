import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGlmUsage } from './glm';

const KEY = 'test-glm-key';

afterEach(() => {
  delete process.env.GLM_API_KEY;
  delete process.env.GLM_API_KEY_2;
  delete process.env.GLM_BASE_URL;
  vi.unstubAllGlobals();
});

function mockGlm(payloadByAuth: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization') || '';
      const payload = payloadByAuth[auth];
      if (!payload) throw new Error(`unexpected key ${auth}`);
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
}

describe('fetchGlmUsage', () => {
  it('keeps TOKENS_LIMIT windows (percent-only)', async () => {
    process.env.GLM_API_KEY = KEY;
    mockGlm({
      [KEY]: {
        success: true,
        data: {
          level: 'max',
          limits: [
            { type: 'TIME_LIMIT', unit: 5, usage: 4000, currentValue: 0, percentage: 0 },
            { type: 'TOKENS_LIMIT', unit: 3, percentage: 33 },
            { type: 'TOKENS_LIMIT', unit: 6, percentage: 73 },
          ],
        },
      },
    });

    const r = await fetchGlmUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.planLabel).toBe('Max');
    expect(r.summary?.limits).toEqual([
      expect.objectContaining({ kind: '5h', percent: 33, label: '5h Window' }),
      expect.objectContaining({ kind: 'weekly', percent: 73, label: 'Weekly' }),
    ]);
  });

  it('maps CREDIT_LIMIT rows to the same windows with exact used/total', async () => {
    process.env.GLM_API_KEY = KEY;
    mockGlm({
      [KEY]: {
        success: true,
        data: {
          level: 'max',
          limits: [
            // usage = window total, currentValue = used (remaining checks out: 28000-11)
            { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 11, remaining: 27988, percentage: 1 },
            { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 11, remaining: 139988, percentage: 1 },
          ],
        },
      },
    });

    const r = await fetchGlmUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.limits).toEqual([
      expect.objectContaining({ kind: '5h', percent: 1, used: 11, total: 28000 }),
      expect.objectContaining({ kind: 'weekly', percent: 1, used: 11, total: 140000 }),
    ]);
  });

  it('merges a TOKENS account with a CREDIT account into one card', async () => {
    process.env.GLM_API_KEY = KEY;
    process.env.GLM_API_KEY_2 = 'key-2';
    mockGlm({
      [KEY]: {
        success: true,
        data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 40 }] },
      },
      ['key-2']: {
        success: true,
        data: { level: 'pro', limits: [{ type: 'CREDIT_LIMIT', unit: 3, usage: 100, currentValue: 90, percentage: 90 }] },
      },
    });

    const r = await fetchGlmUsage();
    expect(r.ok).toBe(true);
    expect(r.summary?.accounts?.map((a) => a.key)).toEqual(['1', '2']);
    // Mixed percent-only + exact rows fall back to the estimated mean.
    const merged5h = r.summary?.limits?.find((l) => l.kind === '5h');
    expect(merged5h?.percent).toBe(65);
    expect(merged5h?.estimated).toBe(true);
  });
});
