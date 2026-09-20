import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  creditLeftRate,
  fetchStepfunUsage,
  isConfigured,
  isCreditPlan,
  parseCredential,
  webIdFromToken,
} from './stepfun';

const ENV_VARS = ['STEPFUN_TOKEN', 'STEPFUN_COOKIE', 'STEPFUN_WEBID', 'STEPFUN_BASE_URL'];
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
  return `${b64({ alg: 'none' })}.${b64({ device_id: deviceId })}.sig`;
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
