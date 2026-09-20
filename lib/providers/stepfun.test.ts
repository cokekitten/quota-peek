import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  creditLeftRate,
  fetchStepfunUsage,
  isConfigured,
  isCreditPlan,
  parseCredential,
  webIdFromToken,
} from './stepfun';

const ENV_VARS = [
  'STEPFUN_TOKEN',
  'STEPFUN_COOKIE',
  'STEPFUN_WEBID',
  'STEPFUN_BASE_URL',
  'STEPFUN_SESSION_FILE',
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
}

afterEach(() => {
  clearEnv();
  for (const [k, v] of saved) setEnv(k, v);
});

/** Minimal unsigned JWT carrying a device_id, so webid derivation is testable. */
function jwt(deviceId: string) {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  // The id goes in the signature too: inside the payload it is only base64, so
  // a stub asserting "this cookie carries that token" could not see it.
  return `${b64({ alg: 'none' })}.${b64({ device_id: deviceId })}.sig-${deviceId}`;
}

describe('credential parsing', () => {
  it('derives the webid from the refresh half of an access...refresh pair', () => {
    const pair = `${jwt('dev-access')}...${jwt('dev-refresh')}`;
    expect(webIdFromToken(pair)).toBe('dev-refresh');
    expect(parseCredential(pair).webid).toBe('dev-refresh');
  });

  it('falls back to the access half when it is the only token', () => {
    expect(parseCredential(jwt('dev-only')).webid).toBe('dev-only');
  });

  it('strips the Oasis-Token= prefix and keeps a full cookie verbatim', () => {
    const frag = parseCredential(`Oasis-Token=${jwt('dev-a')}; Path=/`);
    expect(frag.token).toBe(jwt('dev-a'));
    // `Path=` is a Set-Cookie attribute, not a companion cookie → rebuilt.
    expect(frag.cookie).toBe(`Oasis-Token=${jwt('dev-a')}; Oasis-Webid=dev-a`);

    const full = `Oasis-Token=${jwt('dev-b')}; Oasis-Webid=web-b; INGRESSCOOKIE=xyz`;
    const parsed = parseCredential(full);
    expect(parsed.webid).toBe('web-b'); // taken from the cookie, not the JWT
    expect(parsed.cookie).toBe(full); // sent verbatim, INGRESSCOOKIE intact
  });

  it('honours an explicit webid override and surrounding quotes', () => {
    const parsed = parseCredential(`  "${jwt('dev-jwt')}"  `, 'dev-override');
    expect(parsed.webid).toBe('dev-override');
  });

  it('is configured by either var, at any account index', () => {
    clearEnv();
    expect(isConfigured()).toBe(false);
    setEnv('STEPFUN_COOKIE_2', 'Oasis-Token=x');
    expect(isConfigured()).toBe(true);
    clearEnv();
    setEnv('STEPFUN_TOKEN', 't');
    expect(isConfigured()).toBe(true);
    // Webid / base URL alone are not credentials.
    clearEnv();
    setEnv('STEPFUN_WEBID', 'w');
    setEnv('STEPFUN_BASE_URL', 'https://example.invalid');
    expect(isConfigured()).toBe(false);
  });
});

describe('billing-shape detection', () => {
  it('treats an active window as window-based, whatever plan_family says', () => {
    expect(isCreditPlan({ plan_family: 2, weekly_usage_reset_time: '1777528800' })).toBe(false);
  });

  it('treats a credit pool as credit-based even with zeroed windows', () => {
    expect(
      isCreditPlan({
        plan_family: 2,
        five_hour_usage_reset_time: '0',
        weekly_usage_reset_time: '0',
        plan_credit_rate_limit: { subscription_credit_left_rate: 0.9641 },
      }),
    ).toBe(true);
    // buckets alone are enough
    expect(
      isCreditPlan({ plan_credit_rate_limit: { credit_buckets: [{ credit_total: 100, credit_residual: 40 }] } }),
    ).toBe(true);
  });

  it('falls back to plan_family only when the payload says nothing', () => {
    expect(isCreditPlan({ plan_family: 2 })).toBe(true);
    expect(isCreditPlan({ plan_family: 1 })).toBe(false);
    expect(isCreditPlan({})).toBe(false);
  });

  it('merges buckets by absolute balance and never adds two fractions', () => {
    expect(
      creditLeftRate({
        credit_buckets: [
          { credit_total: 100, credit_residual: 100 },
          { credit_total: 300, credit_residual: 150 },
        ],
      }),
    ).toBeCloseTo(250 / 400, 10);

    // One unsized bucket → cannot weight → subscription rate wins over top-up.
    expect(
      creditLeftRate({
        subscription_credit_left_rate: 0.5,
        topup_credit_left_rate: 0.9,
        credit_buckets: [{ credit_total: 100 }, { credit_total: 300, credit_residual: 150 }],
      }),
    ).toBe(0.5);

    // No buckets at all → still subscription first, top-up only as a last resort.
    expect(creditLeftRate({ subscription_credit_left_rate: 1, topup_credit_left_rate: 0.2 })).toBe(1);
    expect(creditLeftRate({ topup_credit_left_rate: 0.2 })).toBe(0.2);
    expect(creditLeftRate({})).toBeUndefined();
  });
});

// ------------------------------------------------- end-to-end against a stub

let server: http.Server;
let base: string;
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let rateLimitBody = '{}';
let planStatusBody = '{}';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url || '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('QueryStepPlanRateLimit')) return void res.end(rateLimitBody);
      if (req.url?.includes('GetStepPlanStatus')) return void res.end(planStatusBody);
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r, rej) => server.close((e) => (e ? rej(e) : r()))));

describe('fetchStepfunUsage', () => {
  it('sends the oasis headers the platform requires and maps both windows', async () => {
    clearEnv();
    setEnv('STEPFUN_TOKEN', `${jwt('dev-42')}...${jwt('dev-42-refresh')}`);
    setEnv('STEPFUN_BASE_URL', base);
    rateLimitBody = JSON.stringify({
      status: 1,
      // Mixed types on purpose: the real API returns ints, floats and strings.
      five_hour_usage_left_rate: 0.99781543,
      weekly_usage_left_rate: '0.75',
      five_hour_usage_reset_time: String(Math.floor(Date.now() / 1000) + 3600),
      weekly_usage_reset_time: Math.floor(Date.now() / 1000) + 86400,
    });
    planStatusBody = JSON.stringify({ status: 1, subscription: { name: ' Plus ', plan_type: 1 } });

    const result = await fetchStepfunUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.planLabel).toBe('Plus');
    expect(result.summary?.planKey).toBe('Plus');
    expect(result.summary?.limits).toMatchObject([
      { kind: '5h', label: '5h Window', percent: 0 },
      { kind: 'weekly', label: 'Weekly', percent: 25 },
    ]);
    expect(result.summary?.limits?.[0].resetAt).toMatch(/T/);

    const called = seen.filter((r) => r.path.includes('QueryStepPlanRateLimit'))[0];
    expect(called.headers['oasis-appid']).toBe('10300');
    expect(called.headers['oasis-platform']).toBe('web');
    // The webid must be the token's own device_id, or the API rejects the call.
    expect(called.headers['oasis-webid']).toBe('dev-42-refresh');
    expect(String(called.headers.cookie)).toContain('Oasis-Token=');
    expect(String(called.headers.cookie)).toContain('Oasis-Webid=dev-42-refresh');
    expect(called.body).toBe('{}');
  });

  it('renders a credit plan as one Monthly Credit row, not two false 0% windows', async () => {
    clearEnv();
    setEnv('STEPFUN_TOKEN', jwt('dev-credit'));
    setEnv('STEPFUN_BASE_URL', base);
    rateLimitBody = JSON.stringify({
      status: 1,
      plan_family: 2,
      five_hour_usage_left_rate: 0,
      weekly_usage_left_rate: 0,
      five_hour_usage_reset_time: '0',
      weekly_usage_reset_time: '0',
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.9641,
        subscription_credit_reset_time: String(Math.floor(Date.now() / 1000) + 6 * 86400),
        credit_buckets: [
          { credit_total: 1000, credit_residual: 250 },
          { credit_total: 1000, credit_residual: 1000 },
        ],
      },
    });
    planStatusBody = '{}';

    const result = await fetchStepfunUsage();
    expect(result.ok).toBe(true);
    expect(result.summary?.limits).toHaveLength(1);
    expect(result.summary?.limits?.[0]).toMatchObject({ kind: 'monthly', label: 'Monthly Credit', percent: 38 });
    expect(result.summary?.planLabel).toBeUndefined();
  });

  it('surfaces an API-level failure instead of an empty card', async () => {
    clearEnv();
    setEnv('STEPFUN_TOKEN', jwt('dev-nope'));
    setEnv('STEPFUN_BASE_URL', base);
    rateLimitBody = JSON.stringify({ status: 0, message: 'no step plan subscription' });
    planStatusBody = '{}';

    const result = await fetchStepfunUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no step plan subscription');
    expect(result.notConfigured).toBeUndefined();
  });
});

// ------------------------------------------- refresh of an expired access token

const sessionDir = mkdtempSync(path.join(tmpdir(), 'qp-stepfun-session-'));
const sessionPath = path.join(sessionDir, 'session.json');

describe('access-token refresh', () => {
  let authServer: http.Server;
  let authBase: string;
  const stalePair = `${jwt('dev-stale')}...${jwt('dev-stale-webid')}`;
  const freshPair = `${jwt('dev-fresh')}...${jwt('dev-fresh-webid')}`;
  const hits = { rateLimit: [] as string[], refresh: 0 };

  beforeAll(async () => {
    authServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.includes('QueryStepPlanRateLimit')) {
          const cookie = String(req.headers.cookie ?? '');
          hits.rateLimit.push(cookie);
          // The pasted access token is ~30 min old by the time the dashboard
          // refreshes, so anything but a freshly minted token gets rejected.
          if (!cookie.includes('dev-fresh')) {
            res.statusCode = 401;
            return void res.end('{"message":"auth failed: token expired"}');
          }
          return void res.end(
            JSON.stringify({
              status: 1,
              five_hour_usage_left_rate: 0.5,
              weekly_usage_left_rate: 0.5,
              five_hour_usage_reset_time: String(Math.floor(Date.now() / 1000) + 3600),
              weekly_usage_reset_time: String(Math.floor(Date.now() / 1000) + 86400),
            }),
          );
        }
        if (req.url?.includes('RefreshToken')) {
          hits.refresh += 1;
          // The console sends an empty body and carries the session in headers.
          expect(body).toBe('{}');
          expect(String(req.headers['oasis-token'])).toContain('...');
          return void res.end(
            JSON.stringify({ accessToken: { raw: freshPair.split('...')[0] }, refreshToken: { raw: freshPair.split('...')[1] } }),
          );
        }
        if (req.url?.includes('GetStepPlanStatus')) return void res.end('{}');
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r));
    authBase = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r, rej) => authServer.close((e) => (e ? rej(e) : r()))));

  it('renews the pair and re-inserts it into the same cookie', async () => {
    clearEnv();
    setEnv('STEPFUN_COOKIE', `Oasis-Token=${stalePair}; INGRESSCOOKIE=keepme`);
    setEnv('STEPFUN_BASE_URL', authBase);
    setEnv('STEPFUN_SESSION_FILE', sessionPath);
    hits.rateLimit.length = 0;
    hits.refresh = 0;

    const result = await fetchStepfunUsage();
    expect(result.ok, `error was: ${result.error}`).toBe(true);
    expect(result.summary?.limits?.[0]?.percent).toBe(50);
    expect(hits.refresh).toBe(1);
    expect(hits.rateLimit).toHaveLength(2);
    // Retried with the new access token…
    expect(hits.rateLimit[1]).toContain('dev-fresh');
    // …while the rest of the pasted cookie (and its length) is untouched.
    expect(hits.rateLimit[1]).toContain('INGRESSCOOKIE=keepme');
    expect(hits.rateLimit[1].length - hits.rateLimit[0].length).toBeLessThan(200);

    // The rotated pair must survive the process: refresh tokens are single use,
    // so the spent half left in .env is worth nothing after a restart.
    const saved = JSON.parse(readFileSync(sessionPath, 'utf8')) as { pairs: Record<string, string> };
    expect(Object.values(saved.pairs)).toEqual([freshPair]);
    expect(existsSync(sessionPath)).toBe(true);
  });

  it('reuses the persisted pair on a cold start without refreshing again', async () => {
    clearEnv();
    setEnv('STEPFUN_COOKIE', `Oasis-Token=${stalePair}; INGRESSCOOKIE=keepme`);
    setEnv('STEPFUN_BASE_URL', authBase);
    setEnv('STEPFUN_SESSION_FILE', sessionPath); // written by the test above
    hits.rateLimit.length = 0;
    hits.refresh = 0;

    const result = await fetchStepfunUsage();
    expect(result.ok, `error was: ${result.error}`).toBe(true);
    expect(hits.refresh).toBe(0); // straight to the API with the persisted pair
    expect(hits.rateLimit).toHaveLength(1);
    expect(hits.rateLimit[0]).toContain('dev-fresh');
  });

  it('never applies one account’s persisted pair to another account', async () => {
    clearEnv();
    // Account 2 is the *same* credential the session file holds a pair for;
    // account 1 is a different one and must not be handed that pair.
    setEnv('STEPFUN_COOKIE', `Oasis-Token=${jwt('dev-other')}; INGRESSCOOKIE=keepme-a`);
    setEnv('STEPFUN_COOKIE_2', `Oasis-Token=${stalePair}; INGRESSCOOKIE=keepme`);
    setEnv('STEPFUN_BASE_URL', authBase);
    setEnv('STEPFUN_SESSION_FILE', sessionPath); // holds account 2's pair only
    hits.rateLimit.length = 0;
    hits.refresh = 0;

    const result = await fetchStepfunUsage();
    // Account 1 has no cached pair and none to refresh with; account 2 rides on
    // the persisted one — so the card reports account 1's problem only.
    expect(result.ok).toBe(true);
    expect(result.summary?.partial).toBe(true);
    expect(result.summary?.accounts?.[0]).toMatchObject({ ok: false });
    expect(result.summary?.accounts?.[0]?.error).toContain('re-paste');
    expect(result.summary?.accounts?.[1]?.ok).toBe(true);
    expect(hits.refresh).toBe(0);
    // Account 1's call went out with its own token, untouched by the cache.
    expect(hits.rateLimit.some((c) => c.includes('keepme-a') && !c.includes('dev-fresh'))).toBe(true);
  });

  it('tells the user to re-paste when the credential cannot be renewed', async () => {
    clearEnv();
    setEnv('STEPFUN_COOKIE', `Oasis-Token=${jwt('dev-unrenewable')}; INGRESSCOOKIE=keepme`);
    setEnv('STEPFUN_BASE_URL', authBase);
    setEnv('STEPFUN_SESSION_FILE', path.join(sessionDir, 'nothing-here.json'));

    const result = await fetchStepfunUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('re-paste');
  });
});
