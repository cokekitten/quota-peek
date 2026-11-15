import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  cardLimits,
  expireMagpieCacheForTests,
  magpieConfigured,
  magpieCoverage,
  magpieProviderFor,
  magpieProviderResult,
  resetMagpieCacheForTests,
  windowKind,
} from './magpie';
import { configuredMapWithMagpie, fetchOneUsage } from './index';

const ENV_VARS = [
  'MAGPIE_BASE_URL',
  'MAGPIE_GATEWAY_KEY',
  'MAGPIE_API_KEY',
  'MAGPIE_TIMEOUT_MS',
  'MAGPIE_CACHE_TTL_MS',
  'MAGPIE_PREFER',
];
const saved = new Map<string, string | undefined>(ENV_VARS.map((v) => [v, process.env[v]]));

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearEnv() {
  for (const v of ENV_VARS) setEnv(v);
}

afterEach(() => {
  clearEnv();
  for (const [k, v] of saved) setEnv(k, v);
  resetMagpieCacheForTests();
});

describe('provider + window mapping', () => {
  it('maps the magpie providers that stand for a dashboard card', () => {
    expect(magpieProviderFor({ provider: 'devin' })).toBe('devin');
    expect(magpieProviderFor({ provider: 'antigravity' })).toBe('gemini');
    expect(magpieProviderFor({ provider: 'claude' })).toBe('claude');
    expect(magpieProviderFor({ provider: 'agy-cli' })).toBe('gemini');
    expect(magpieProviderFor({ provider: 'openai' })).toBeUndefined();
    expect(magpieProviderFor({})).toBeUndefined();
  });

  it('turns magpie window names into the card kinds', () => {
    expect(windowKind({ provider: 'devin' }, { name: '7 days' })).toEqual({
      kind: 'weekly',
      label: 'Weekly',
    });
    expect(windowKind({ provider: 'devin' }, { name: '1 day' })).toEqual({
      kind: 'daily',
      label: 'Daily',
    });
    // The quota report names the provider agy-cli and puts the pool in the
    // window name instead of a pool field.
    expect(windowKind({ provider: 'agy-cli' }, { name: 'Gemini · 5 hours' })).toEqual({
      kind: '5h',
      label: '5h Window',
    });
    expect(windowKind({ provider: 'agy-cli' }, { name: 'Claude & GPT · 7 days' })).toEqual({
      kind: '3p_weekly',
      label: '3P Models · Weekly',
    });
    expect(windowKind({ provider: 'cursor' }, { name: 'Grok Bot' })).toEqual({
      kind: 'grok-bot',
      label: 'Grok Bot',
    });
    // Antigravity's pooled windows: the Gemini half is the card's own quota,
    // the rest is the 3P half — same split as the native provider.
    expect(
      windowKind({ provider: 'antigravity' }, { name: '5 hours', pool: 'Gemini' }),
    ).toEqual({ kind: '5h', label: '5h Window' });
    expect(
      windowKind({ provider: 'antigravity' }, { name: '7 days', pool: 'Gemini' }),
    ).toEqual({ kind: 'weekly', label: 'Weekly' });
    expect(
      windowKind({ provider: 'antigravity' }, { name: '5 hours', pool: 'Claude & GPT' }),
    ).toEqual({ kind: '3p_5h', label: '3P Models · 5h' });
    expect(
      windowKind({ provider: 'antigravity' }, { name: '7 days', pool: 'Claude & GPT' }),
    ).toEqual({ kind: '3p_weekly', label: '3P Models · Weekly' });
  });

  it('drops text-only windows, which carry no percentage', () => {
    const limits = cardLimits({
      provider: 'cursor',
      windows: [
        { name: 'Weekly', used: 0.3, resetsAt: '2026-11-18T08:06:44.633Z' },
        { name: 'On-demand', used: 0, display: '$0.00', text: true },
      ],
    });
    expect(limits).toEqual([
      { label: 'Weekly', kind: 'weekly', percent: 0.3, resetAt: '2026-11-18T08:06:44.633Z' },
    ]);
  });
});

// ------------------------------------------------- end-to-end against a stub

let server: http.Server;
let base: string;
let seen: Array<{ path: string; auth?: string }> = [];
let status = 200;
let body = '{}';

function quotas(data: unknown[]) {
  return JSON.stringify({ object: 'list', data });
}

function devinCard(used = 4, extra: Record<string, unknown> = {}) {
  return {
    provider: 'devin',
    name: 'Devin',
    kind: 'subscription',
    user: 'cat@example.com · 可乐小猫',
    windows: [{ name: '7 days', used, resetsAt: '2026-11-15T08:00:00Z' }],
    ...extra,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ path: req.url || '', auth: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function useStub() {
  seen = [];
  status = 200;
  clearEnv();
  setEnv('MAGPIE_BASE_URL', base);
  setEnv('MAGPIE_GATEWAY_KEY', 'gw_test');
}

describe('magpie as a source', () => {
  it('needs both a base URL and a key to count as configured', () => {
    clearEnv();
    expect(magpieConfigured()).toBe(false);
    setEnv('MAGPIE_BASE_URL', base);
    expect(magpieConfigured()).toBe(false);
    setEnv('MAGPIE_GATEWAY_KEY', 'gw_test');
    expect(magpieConfigured()).toBe(true);
  });

  it('reads /v1/magpie/quotas with the gateway key and maps every card', async () => {
    useStub();
    body = quotas([
      devinCard(4),
      {
        provider: 'antigravity',
        name: 'Antigravity',
        kind: 'subscription',
        plan: 'Google AI Ultra',
        windows: [
          { name: '7 days', used: 0.84, resetsAt: '2026-11-20T23:07:56Z', pool: 'Gemini' },
          { name: '5 hours', used: 1.03, resetsAt: '2026-11-14T19:07:56Z', pool: 'Gemini' },
          { name: '7 days', used: 0.0047, resetsAt: '2026-11-18T07:24:12Z', pool: 'Claude & GPT' },
          { name: '5 hours', used: 0, resetsAt: '2026-11-14T20:24:51Z', pool: 'Claude & GPT' },
        ],
      },
      {
        provider: 'cursor',
        name: 'Cursor',
        kind: 'subscription',
        plan: 'Ultra',
        windows: [
          { name: 'Weekly', used: 0.33, resetsAt: '2026-11-18T08:06:44.633Z' },
          { name: 'On-demand', used: 0, display: '$0.00', text: true },
        ],
      },
      // A pay-as-you-go wallet is not a plan quota.
      { provider: 'deepseek', name: 'DeepSeek', kind: 'balance', windows: [] },
    ]);

    expect(await magpieCoverage()).toEqual({ devin: true, gemini: true, cursor: true });
    expect(seen[0].path).toBe('/v1/magpie/quotas');
    expect(seen[0].auth).toBe('Bearer gw_test');

    const devin = await magpieProviderResult('devin');
    expect(devin?.ok).toBe(true);
    // No plan in magpie's Devin card: the tag stays 'live' rather than repeating the name.
    expect(devin?.summary?.planLabel).toBeUndefined();
    expect(devin?.summary?.limits).toEqual([
      { label: 'Weekly', kind: 'weekly', percent: 4, resetAt: '2026-11-15T08:00:00.000Z' },
    ]);

    const gemini = await magpieProviderResult('gemini');
    expect(gemini?.ok).toBe(true);
    expect(gemini?.summary?.planLabel).toBe('Google AI Ultra');
    expect(gemini?.summary?.limits?.map((l) => [l.kind, l.percent])).toEqual([
      ['weekly', 0.8],
      ['5h', 1],
      ['3p_weekly', 0],
      ['3p_5h', 0],
    ]);

    const cursor = await magpieProviderResult('cursor');
    expect(cursor?.summary?.limits?.map((l) => l.kind)).toEqual(['weekly']);

    // One fetch serves every card in the round.
    expect(seen).toHaveLength(1);
  });

  it('merges magpie accounts of one provider into the card tabs', async () => {
    useStub();
    body = quotas([
      devinCard(4, { user: 'a@example.com' }),
      devinCard(90, { user: 'b@example.com', plan: 'Devin Teams' }),
    ]);

    const result = await magpieProviderResult('devin');
    expect(result?.ok).toBe(true);
    expect(result?.summary?.accounts?.map((a) => a.key)).toEqual(['1', '2']);
    expect(result?.summary?.accounts?.[1].planLabel).toBe('Devin Teams');
    expect(result?.summary?.limits?.[0]).toMatchObject({ kind: 'weekly' });
    expect(result?.summary?.limits?.[0].percent).toBe(47); // mean of 4 and 90
  });

  it('answers undefined for a provider magpie does not carry', async () => {
    useStub();
    body = quotas([devinCard()]);
    expect(await magpieProviderResult('glm')).toBeUndefined();
  });

  it('returns an offline card for a provider magpie used to carry', async () => {
    useStub();
    body = quotas([devinCard()]);
    expect((await magpieProviderResult('devin'))?.ok).toBe(true);

    // magpie goes down; last good read still says it carried Devin.
    expireMagpieCacheForTests();
    status = 500;
    body = JSON.stringify({ error: { message: 'boom' } });
    const result = await magpieProviderResult('devin');
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('magpie answered HTTP 500');
    // ... while a provider it never carried stays hidden.
    expect(await magpieProviderResult('glm')).toBeUndefined();
  });

  it('counts magpie-covered providers as configured', async () => {
    useStub();
    body = quotas([devinCard()]);
    const map = await configuredMapWithMagpie();
    expect(map.devin).toBe(true);
    expect(map.glm).toBe(false);
  });

  it('feeds fetchOneUsage from magpie unless MAGPIE_PREFER=0', async () => {
    useStub();
    body = quotas([devinCard(33)]);
    const bridged = await fetchOneUsage('devin');
    expect(bridged.ok).toBe(true);
    expect(bridged.summary?.limits?.[0].percent).toBe(33);

    // A provider magpie doesn't carry still reports its own missing key.
    const glm = await fetchOneUsage('glm');
    expect(glm).toMatchObject({ ok: false, notConfigured: true });
    expect(glm.error).toContain('GLM_API_KEY');
  });
});
