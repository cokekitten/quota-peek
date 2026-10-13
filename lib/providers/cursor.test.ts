import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The keychain is a macOS subprocess — never hit the real one in tests. The
// default mock makes the item look absent; the keychain tests override it.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => { throw new Error('absent'); }) }));

import { execFileSync } from 'node:child_process';
import { fetchCursorUsage, isConfigured } from './cursor';

const ENV_VARS = [
  'CURSOR_ACCESS_TOKEN',
  'CURSOR_BASE_URL',
  'CURSOR_NO_KEYCHAIN',
  'CURSOR_TIMEOUT_MS',
];
const saved = new Map<string, string | undefined>(ENV_VARS.map((v) => [v, process.env[v]]));

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearEnv() {
  for (const v of ENV_VARS) {
    for (let n = 1; n <= 9; n++) setEnv(n === 1 ? v : `${v}_${n}`);
  }
  // Keep the keychain out of every test unless a test opts in: on a dev mac
  // the real `cursor-access-token` item exists and would flip isConfigured().
  setEnv('CURSOR_NO_KEYCHAIN', '1');
}

afterEach(() => {
  clearEnv();
  for (const [k, v] of saved) setEnv(k, v);
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('absent');
  });
});

describe('isConfigured', () => {
  it('is unconfigured with no token and no keychain', () => {
    clearEnv();
    expect(isConfigured()).toBe(false);
  });

  it('is configured by an env token at any account index', () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN_2', 'jwt-2');
    expect(isConfigured()).toBe(true);
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-1');
    expect(isConfigured()).toBe(true);
  });

  it('is configured by the macOS keychain item, and NO_KEYCHAIN opts out', () => {
    if (process.platform !== 'darwin') return; // keychain path is darwin-only
    clearEnv();
    setEnv('CURSOR_NO_KEYCHAIN', undefined);
    vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
    expect(isConfigured()).toBe(true);
    setEnv('CURSOR_NO_KEYCHAIN', '1');
    expect(isConfigured()).toBe(false);
  });
});

// ------------------------------------------------- end-to-end against a stub

let server: http.Server;
let base: string;
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let usageBody = '{}';
let usageStatus = 200;
let sandBody = '{}';
let sandStatus = 200;

/** The real shape of GetCurrentPeriodUsage on an individual plan. */
function usageFixture(puOver: Record<string, unknown> = {}, topOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    billingCycleStart: '1791809353000',
    billingCycleEnd: '1794487753000',
    planUsage: {
      totalSpend: 810,
      includedSpend: 810,
      remaining: 39190,
      limit: 40000,
      remainingBonus: false,
      autoPercentUsed: 0.072,
      apiPercentUsed: 5.94,
      totalPercentUsed: 0.26129,
      ...puOver,
    },
    spendLimitUsage: { limitType: 'user' },
    enabled: true,
    displayMessage: "You've used 2% of your included usage",
    ...topOver,
  });
}

function sandFixture(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    currentPeriodStart: '2026-10-07T12:50:40.651Z',
    nextResetTimestampUtc: '2026-10-14T12:50:40.651Z',
    usagePercent: 0.286901,
    hasAvailableUsage: true,
    hasNonZeroIncludedLimit: true,
    grokPlanLabel: 'Grok Bot Plan',
    cursorPlanName: 'Ultra',
    billingBrand: 'SAND_BILLING_BRAND_CURSOR',
    ...over,
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url || '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('GetCurrentPeriodUsage')) {
        res.statusCode = usageStatus;
        return void res.end(usageBody);
      }
      if (req.url?.includes('GetSandUsageStatus')) {
        res.statusCode = sandStatus;
        return void res.end(sandBody);
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r, rej) => server.close((e) => (e ? rej(e) : r()))));

describe('fetchCursorUsage', () => {
  it('maps both model pools plus the weekly Grok Bot row', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-1');
    setEnv('CURSOR_BASE_URL', base);
    usageStatus = 200;
    usageBody = usageFixture();
    sandStatus = 200;
    sandBody = sandFixture();

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Ultra');
    expect(result.summary?.planKey).toBe('Ultra');
    expect(result.summary?.limits).toMatchObject([
      {
        kind: 'cursor-models',
        label: 'Cursor Models',
        percent: 0.1, // 0.072 → one decimal, not a flat 0
        resetAt: new Date(1794487753000).toISOString(),
      },
      { kind: 'other-models', label: 'Other Models', percent: 5.9 },
      {
        kind: 'grok-bot',
        label: 'Grok Bot',
        percent: 0.3, // 0.286901 → one decimal
        resetAt: '2026-10-14T12:50:40.651Z',
      },
    ]);

    const usage = seen.find((r) => r.path.includes('GetCurrentPeriodUsage'));
    expect(usage?.headers.authorization).toBe('Bearer jwt-1');
    expect(usage?.headers['connect-protocol-version']).toBe('1');
    expect(usage?.body).toBe('{}');
  });

  it('adds an On-Demand row only when the spend limit is configured', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-1');
    setEnv('CURSOR_BASE_URL', base);
    usageBody = usageFixture(
      {},
      {
        spendLimitUsage: {
          totalSpend: 500,
          individualLimit: 10000,
          individualUsed: 500,
          individualRemaining: 9500,
          limitType: 'user',
        },
      },
    );
    sandBody = sandFixture();

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(true);
    const rows = result.summary?.limits ?? [];
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      kind: 'spend',
      label: 'On-Demand',
      percent: 5,
      used: 5,
      total: 100,
      unit: '$',
    });
  });

  it('keeps the card when the Grok Bot lookup fails', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-1');
    setEnv('CURSOR_BASE_URL', base);
    usageBody = usageFixture();
    sandStatus = 500;
    sandBody = '{"code":"internal"}';

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(true);
    expect((result.summary?.limits ?? []).map((l) => l.kind)).toEqual([
      'cursor-models',
      'other-models',
    ]);
    // Plan name came from the sand payload before; without it there is none.
    expect(result.summary?.planLabel).toBeUndefined();
  });

  it('fails with a login hint on 401', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'spent-jwt');
    setEnv('CURSOR_BASE_URL', base);
    usageStatus = 401;
    usageBody = '{}';

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cursor-agent login/);
  });

  it('fails when the response carries no planUsage (team shape)', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-team');
    setEnv('CURSOR_BASE_URL', base);
    usageStatus = 200;
    usageBody = usageFixture({}, { planUsage: undefined });

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/planUsage/);
  });

  it('merges two accounts behind the Σ toggle', async () => {
    clearEnv();
    setEnv('CURSOR_ACCESS_TOKEN', 'jwt-a');
    setEnv('CURSOR_ACCESS_TOKEN_2', 'jwt-b');
    // Base URL is per-account: without _2 the second account would dial the
    // real api2.cursor.sh from inside a test.
    setEnv('CURSOR_BASE_URL', base);
    setEnv('CURSOR_BASE_URL_2', base);
    usageStatus = 200;
    usageBody = usageFixture({ autoPercentUsed: 40, apiPercentUsed: 25.94 });
    sandStatus = 200;
    sandBody = sandFixture();

    const result = await fetchCursorUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.accounts).toHaveLength(2);
    expect(result.summary?.partial).toBeUndefined();
    // Same planKey on both rows → the mean of fractions is exact, not ≈
    // (mergeLimits rounds percent-only rows to integers — same as stepfun).
    const cursorRow = result.summary?.limits?.find((l) => l.kind === 'cursor-models');
    expect(cursorRow?.percent).toBe(40);
    expect(cursorRow?.estimated).toBeUndefined();
  });
});
