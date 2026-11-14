import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
  defaultCredentialsPath,
  fetchDevinUsage,
  isConfigured,
  readDevinCredentials,
  tierName,
} from './devin';

const ENV_VARS = [
  'DEVIN_API_KEY',
  'DEVIN_BASE_URL',
  'DEVIN_CREDENTIALS_PATH',
  'DEVIN_TIMEOUT_MS',
  'DEVIN_CLI_VERSION',
];
const saved = new Map<string, string | undefined>(ENV_VARS.map((v) => [v, process.env[v]]));

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A path that never exists, so a dev machine's own devin login can't leak in. */
const MISSING = path.join(tmpdir(), 'qp-devin-definitely-missing', 'credentials.toml');

function clearEnv() {
  for (const v of ENV_VARS) {
    for (let n = 1; n <= 9; n++) setEnv(n === 1 ? v : `${v}_${n}`);
  }
  setEnv('DEVIN_CREDENTIALS_PATH', MISSING);
}

afterEach(() => {
  clearEnv();
  for (const [k, v] of saved) setEnv(k, v);
});

describe('credentials', () => {
  it('reads windsurf_api_key and api_server_url from credentials.toml', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-devin-'));
    const file = path.join(dir, 'credentials.toml');
    writeFileSync(
      file,
      [
        'windsurf_api_key = "cog_abc"',
        'api_server_url = "https://example.invalid"',
        'devin_webapp_host = "app.devin.ai"',
      ].join('\n'),
    );
    expect(readDevinCredentials(file)).toEqual({
      apiKey: 'cog_abc',
      baseUrl: 'https://example.invalid',
    });
    expect(readDevinCredentials(path.join(dir, 'missing.toml'))).toEqual({});
    setEnv('DEVIN_CREDENTIALS_PATH', MISSING);
    expect(defaultCredentialsPath()).toBe(MISSING); // env override wins
  });

  it('is configured by an env key at any account index, or by the CLI sign-in', () => {
    clearEnv();
    expect(isConfigured()).toBe(false);
    setEnv('DEVIN_API_KEY_3', 'cog_3');
    expect(isConfigured()).toBe(true);

    clearEnv();
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-devin-'));
    const file = path.join(dir, 'credentials.toml');
    writeFileSync(file, 'windsurf_api_key = "cog_file"\n');
    setEnv('DEVIN_CREDENTIALS_PATH', file);
    expect(isConfigured()).toBe(true);

    // A file without a key is not a sign-in.
    writeFileSync(file, 'api_server_url = "https://server.codeium.com"\n');
    expect(isConfigured()).toBe(false);
  });
});

describe('tierName', () => {
  it('turns a teams tier into the CLI plan name', () => {
    expect(tierName('TEAMS_TIER_DEVIN_PRO')).toBe('Devin Pro');
    expect(tierName('TEAMS_TIER_DEVIN_TEAMS_V2')).toBe('Devin Teams');
    expect(tierName(undefined)).toBeUndefined();
    expect(tierName('UNSPECIFIED')).toBeUndefined();
  });
});

// ------------------------------------------------- end-to-end against a stub

let server: http.Server;
let base: string;
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let status = 200;
let body = '{}';

function userStatus(planStatus: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    userStatus: {
      email: 'cat@example.com',
      teamsTier: 'TEAMS_TIER_DEVIN_PRO',
      planStatus,
      ...over,
    },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ path: req.url || '', headers: req.headers, body: raw });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function resetStub() {
  seen = [];
  status = 200;
  body = '{}';
  clearEnv();
  setEnv('DEVIN_API_KEY', 'cog_test');
  setEnv('DEVIN_BASE_URL', base);
}

const RESET_DAY = 1_765_000_000;
const RESET_WEEK = 1_765_500_000;

describe('fetchDevinUsage', () => {
  it('asks GetUserStatus with the key in metadata, and shows used = 100 − left', async () => {
    resetStub();
    body = userStatus({
      planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA', planName: 'Pro' },
      dailyQuotaRemainingPercent: 62.5,
      dailyQuotaResetAtUnix: RESET_DAY,
      weeklyQuotaRemainingPercent: 90,
      weeklyQuotaResetAtUnix: RESET_WEEK,
    });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Devin Pro'); // teamsTier beats planInfo.planName
    expect(result.summary?.limits).toEqual([
      {
        label: 'Daily',
        kind: 'daily',
        percent: 37.5,
        resetAt: new Date(RESET_DAY * 1000).toISOString(),
      },
      {
        label: 'Weekly',
        kind: 'weekly',
        percent: 10,
        resetAt: new Date(RESET_WEEK * 1000).toISOString(),
      },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe(
      '/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    );
    expect(seen[0].headers['connect-protocol-version']).toBe('1');
    // The key travels in metadata.apiKey (as the CLI sends it), not a bearer header.
    expect(seen[0].headers.authorization).toBeUndefined();
    const sent = JSON.parse(seen[0].body);
    expect(sent.metadata).toMatchObject({ apiKey: 'cog_test', ideName: 'devin-cli' });
  });

  it('reads a used-up quota out of the omitted zero on a quota-billed plan', async () => {
    resetStub();
    body = userStatus({
      planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA' },
      dailyQuotaRemainingPercent: 100,
      dailyQuotaResetAtUnix: RESET_DAY,
      // weeklyQuotaRemainingPercent omitted: JSON drops a 0, so the week is maxed.
      weeklyQuotaResetAtUnix: RESET_WEEK,
    });

    const limits = (await fetchDevinUsage()).summary?.limits;
    expect(limits?.map((l) => [l.kind, l.percent])).toEqual([
      ['daily', 0],
      ['weekly', 100],
    ]);
  });

  it('drops daily/weekly rows on a plan billed another way, and honors hide flags', async () => {
    resetStub();
    body = userStatus({
      planInfo: { billingStrategy: 'BILLING_STRATEGY_ACU', hideWeeklyQuota: true },
      dailyQuotaResetAtUnix: RESET_DAY, // reset but no share: not a quota window
      weeklyQuotaRemainingPercent: 50,
      weeklyQuotaResetAtUnix: RESET_WEEK,
    });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no quota, ACU or balance');
  });

  it('shows ACUs and the overage balance when the plan has them', async () => {
    resetStub();
    body = userStatus({
      planInfo: { billingStrategy: 'BILLING_STRATEGY_ACU', planName: 'Teams' },
      acuLimit: 250,
      acuConsumed: 12.5,
      overageBalanceMicros: 12_345_678,
      planEnd: '2026-12-01T00:00:00Z',
    });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Devin Pro');
    expect(result.summary?.limits).toEqual([
      {
        label: 'ACUs',
        kind: 'credits',
        percent: 5,
        used: 12.5,
        total: 250,
        unit: 'ACU',
        resetAt: '2026-12-01T00:00:00.000Z',
      },
      {
        label: 'Overage Balance',
        kind: 'balance',
        percent: 0,
        used: 12.35,
        unit: '$',
      },
    ]);
  });

  it('explains a rejected key instead of an empty card', async () => {
    resetStub();
    status = 401;
    body = JSON.stringify({ code: 'unauthenticated', message: 'invalid api key' });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Devin rejected the key');
    expect(result.error).toContain('DEVIN_API_KEY');
  });

  it('surfaces a non-auth Connect error message', async () => {
    resetStub();
    status = 400;
    body = JSON.stringify({ code: 'invalid_argument', message: 'metadata is required' });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 400: invalid_argument: metadata is required');
  });

  it('falls back to the CLI sign-in file for a key and an API server', async () => {
    resetStub();
    clearEnv();
    setEnv('DEVIN_CREDENTIALS_PATH', (() => {
      const dir = mkdtempSync(path.join(tmpdir(), 'qp-devin-'));
      const file = path.join(dir, 'credentials.toml');
      writeFileSync(
        file,
        `windsurf_api_key = "cog_file"\napi_server_url = "${base}"\n`,
      );
      return file;
    })());
    body = userStatus({ dailyQuotaRemainingPercent: 100, dailyQuotaResetAtUnix: RESET_DAY });

    const result = await fetchDevinUsage();
    expect(result.ok).toBe(true);
    expect(JSON.parse(seen[0].body).metadata.apiKey).toBe('cog_file');
  });

  it('names the variable to set when there is no key at all', async () => {
    clearEnv();
    const result = await fetchDevinUsage();
    expect(result).toMatchObject({ ok: false, provider: 'devin' });
    expect(result.error).toContain('DEVIN_API_KEY');
  });
});
