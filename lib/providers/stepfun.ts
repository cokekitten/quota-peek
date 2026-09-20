import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * StepFun (阶跃星辰) Step Plan usage.
 *
 * The plan quota lives on platform.stepfun.com behind the web session, not
 * behind the `sk-` API key (that one only exposes the top-up balance at
 * GET /v1/accounts). Two undocumented-but-stable JSON endpoints, both POST
 * with an empty `{}` body and the platform's `oasis-*` headers:
 *
 *   /api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit  → windows
 *   /api/step.openapi.devcenter.Dashboard/GetStepPlanStatus       → plan name
 *
 * Auth is either a pasted browser Cookie header (`STEPFUN_COOKIE`, includes
 * Oasis-Token + Oasis-Webid + INGRESSCOOKIE) or a bare/paired Oasis-Token
 * (`STEPFUN_TOKEN`, `access...refresh`). A token alone is not enough: the
 * `oasis-webid` header must equal the token's `device_id` claim, or the server
 * answers "auth failed: oasis-token is embezzled" — so it is decoded from the
 * JWT payload. With the refresh half present, an expired access token is
 * renewed through PassportService/RefreshToken (kept in memory only; nothing
 * is written back, so a read-only secret mount can't burn the session).
 *
 * Since the 2026-06 Step Plan upgrade there are two billing shapes, and the
 * rate-limit response does not label them reliably — see isCreditPlan().
 */

const DEFAULT_BASE_URL = 'https://platform.stepfun.com';
const RATE_LIMIT_PATH = '/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit';
const PLAN_STATUS_PATH = '/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus';
const REFRESH_PATH = '/passport/proto.api.passport.v1.PassportService/RefreshToken';
const TIMEOUT_MS = Number(process.env.STEPFUN_TIMEOUT_MS || 15000);
const APP_ID = '10300';
// Only used before any token exists to derive a real device_id from.
const DEFAULT_WEBID = 'c8a1002d2c457e758785a9979832217c7c0b884c';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// Env vars forming one account's config; the token or cookie is what marks it.
const ENV_VARS = ['STEPFUN_TOKEN', 'STEPFUN_COOKIE', 'STEPFUN_WEBID', 'STEPFUN_BASE_URL'];
const TRIGGER_VARS = ['STEPFUN_TOKEN', 'STEPFUN_COOKIE'];

interface StepFunAccount {
  token?: string;
  cookie?: string;
  webid?: string;
  /** Env var names, for error messages. */
  tokenEnv: string;
  cookieEnv: string;
  baseUrl: string;
}

/** Env values that mark an account as configured. */
export function isConfigured(): boolean {
  return readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some(
    (a) => Boolean(a.env.STEPFUN_TOKEN || a.env.STEPFUN_COOKIE),
  );
}

export function fetchStepfunUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).map(
    ({ key, env }) => ({
      key,
      config: {
        token: env.STEPFUN_TOKEN,
        // A full browser Cookie header wins: it is already self-consistent.
        cookie: env.STEPFUN_COOKIE,
        webid: env.STEPFUN_WEBID,
        tokenEnv: accountEnvName('STEPFUN_TOKEN', key),
        cookieEnv: accountEnvName('STEPFUN_COOKIE', key),
        baseUrl: (env.STEPFUN_BASE_URL || process.env.STEPFUN_BASE_URL || DEFAULT_BASE_URL).replace(
          /\/$/,
          '',
        ),
      },
    }),
  );
  return fetchMultiAccount(accounts, fetchStepfunAccount, {
    provider: 'stepfun',
    label: 'StepFun',
  });
}

// ---------------------------------------------------------------- response types

/** The API mixes numbers, numeric strings and numeric timestamps. */
type Loose = number | string | null | undefined;

interface RateLimitResponse {
  status?: Loose;
  message?: string;
  desc?: string;
  code?: Loose;
  five_hour_usage_left_rate?: Loose;
  weekly_usage_left_rate?: Loose;
  five_hour_usage_reset_time?: Loose;
  weekly_usage_reset_time?: Loose;
  plan_family?: Loose;
  plan_credit_rate_limit?: {
    subscription_credit_left_rate?: Loose;
    subscription_credit_reset_time?: Loose;
    topup_credit_left_rate?: Loose;
    credit_buckets?: Array<{
      credit_total?: Loose;
      credit_residual?: Loose;
      expire_at?: Loose;
      next_reset_at?: Loose;
    }>;
  };
}

interface PlanStatusResponse {
  status?: Loose;
  subscription?: { name?: string; plan_type?: Loose; status?: Loose };
}

/** Credit-plan detection by payload shape, not by `plan_family` alone. */
export function isCreditPlan(d: RateLimitResponse): boolean {
  const num = (v: Loose) => (v === undefined || v === null ? NaN : Number(v));
  // 1. An active window proves window-based billing.
  if (num(d.five_hour_usage_reset_time) > 0 || num(d.weekly_usage_reset_time) > 0) return false;
  // 2. Otherwise a credit pool proves credit-based billing.
  const credit = d.plan_credit_rate_limit;
  if (
    credit &&
    (credit.subscription_credit_left_rate !== undefined ||
      credit.topup_credit_left_rate !== undefined ||
      (credit.credit_buckets?.length ?? 0) > 0)
  ) {
    return true;
  }
  // 3. Only when the payload says nothing, fall back to the family code.
  return num(d.plan_family) === 2;
}

/**
 * Combined remaining credit fraction. Subscription and top-up rates are
 * *independent* fractions (each relative to its own pool), so they must not be
 * added: prefer absolute bucket balances, and only fall back to the
 * subscription rate — the plan allowance — when buckets carry no sizes.
 */
export function creditLeftRate(credit: NonNullable<RateLimitResponse['plan_credit_rate_limit']>) {
  const num = (v: Loose) => (v === undefined || v === null ? NaN : Number(v));
  const buckets = credit.credit_buckets ?? [];
  if (buckets.length) {
    const sized = buckets
      .map((b) => ({ total: num(b.credit_total), residual: num(b.credit_residual) }))
      .filter(
        (b) =>
          Number.isFinite(b.total) &&
          Number.isFinite(b.residual) &&
          b.total > 0 &&
          b.residual >= 0 &&
          b.residual <= b.total,
      );
    if (sized.length === buckets.length) {
      const total = sized.reduce((s, b) => s + b.total, 0);
      const residual = sized.reduce((s, b) => s + b.residual, 0);
      return residual / total;
    }
  }
  const sub = num(credit.subscription_credit_left_rate);
  if (Number.isFinite(sub)) return sub;
  const topup = num(credit.topup_credit_left_rate);
  return Number.isFinite(topup) ? topup : undefined;
}

/** Cookie *attributes* (not values) that appear when a Set-Cookie is pasted. */
const COOKIE_ATTRS = /^(path|domain|expires|max-age|samesite|secure|httponly)$/i;

/** Normalize a pasted credential into the cookie + webid to send. */
export function parseCredential(raw: string, webidOverride?: string) {
  const cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  const pairs = cleaned.split(/;\s*/).filter(Boolean);
  const value = (name: string) => {
    const hit = pairs.find((p) => p.toLowerCase().startsWith(`${name.toLowerCase()}=`));
    return hit?.slice(name.length + 1);
  };
  const token = value('Oasis-Token');
  const isBareToken = !token;
  const jwt = token ?? cleaned;
  const webid =
    webidOverride || (isBareToken ? webIdFromToken(jwt) : value('Oasis-Webid') || webIdFromToken(jwt));
  // Anything besides the token itself and cookie attributes means the user
  // pasted a whole Cookie header — send it verbatim so INGRESSCOOKIE etc.
  // stay consistent with it, instead of rebuilding a partial copy.
  const hasCompanions = pairs.some(
    (p) => !/^oasis-token=/i.test(p) && !/^oasis-webid=/i.test(p) && !COOKIE_ATTRS.test(p.split('=')[0]),
  );
  if (isBareToken || !hasCompanions) {
    return {
      token: jwt,
      webid,
      cookie: webid ? `Oasis-Token=${jwt}; Oasis-Webid=${webid}` : `Oasis-Token=${jwt}`,
    };
  }
  return { token: jwt, webid, cookie: cleaned };
}

/**
 * The Oasis-Webid must equal the token's `device_id` claim. In an
 * `access...refresh` pair the claim lives in the refresh half, so try halves
 * back-to-front.
 */
export function webIdFromToken(token: string): string | undefined {
  for (const half of token.split('...').reverse()) {
    const id = deviceIdFromJwt(half);
    if (id) return id;
  }
  return undefined;
}

function deviceIdFromJwt(jwt: string): string | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
      device_id?: unknown;
    };
    return typeof json.device_id === 'string' && json.device_id ? json.device_id : undefined;
  } catch {
    return undefined;
  }
}

/** Put a freshly issued token pair back into the credential it came from. */
function swapToken(credential: string, pair: string): string {
  return /oasis-token=/i.test(credential)
    ? credential.replace(/(Oasis-Token=)[^;]+/i, `$1${pair}`)
    : pair;
}

/** 10-digit unix seconds (string or number) → ISO, or undefined for 0/absent. */
function isoFromUnix(v: Loose): string | undefined {
  const n = v === undefined || v === null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

function percentUsed(leftRate: number): number {
  return Math.max(0, Math.min(100, Math.round((1 - leftRate) * 100)));
}

// ---------------------------------------------------------------------- fetch

/** In-memory refreshed pairs, keyed by the credential we were given. */
const refreshed = new Map<string, string>();

/**
 * Where rotated pairs survive. StepFun rotates the refresh token on every
 * renewal, so losing a pair means losing the session for good: the pasted
 * cookie still carries the spent half. Without this, every container restart
 * would demand a fresh paste — hence the default, plus the writable mount in
 * docker-compose.yml. This is *our* cache, not a CLI credential file, so
 * writing it back cannot burn anyone's login (the SuperGrok :ro lesson).
 *
 * Pairs are keyed by a fingerprint of the credential they came from, so a
 * multi-account card never applies account 1's renewed token to account 2.
 */
function sessionFile(): string {
  return process.env.STEPFUN_SESSION_FILE || path.join(process.cwd(), '.stepfun-session.json');
}

function sessionKey(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 16);
}

function readSessionMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as { pairs?: unknown };
    return parsed && typeof parsed.pairs === 'object' && parsed.pairs
      ? (parsed.pairs as Record<string, string>)
      : {};
  } catch {
    return {}; // missing, unreadable or malformed → the pasted credentials stand
  }
}

function persistPair(credential: string, pair: string) {
  const map = { ...readSessionMap(), [sessionKey(credential)]: pair };
  try {
    fs.writeFileSync(
      sessionFile(),
      JSON.stringify({ pairs: map, savedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch {
    /* read-only mount or unwritable path: keep serving from memory */
  }
}

async function fetchStepfunAccount(account: StepFunAccount): Promise<ProviderResult> {
  const provider = 'stepfun' as const;
  const label = 'StepFun';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  const raw = account.cookie || account.token;
  if (!raw) {
    return fail(`Neither ${account.tokenEnv} nor ${account.cookieEnv} is set`);
  }
  // Access tokens live ~30 min while the pasted credential stays in .env, so a
  // pair renewed in an earlier round (this process, or a previous container)
  // is used before we ever hit an auth error.
  const cachedPair = refreshed.get(raw) ?? readSessionMap()[sessionKey(raw)];
  let cred = parseCredential(cachedPair ? swapToken(raw, cachedPair) : raw, account.webid);

  const call = async (path: string) => {
    const resp = await fetch(`${account.baseUrl}${path}`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'oasis-appid': APP_ID,
        'oasis-platform': 'web',
        'oasis-webid': cred.webid || DEFAULT_WEBID,
        'user-agent': USER_AGENT,
        cookie: cred.cookie,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: resp.status, body: await resp.text() };
  };

  const isAuthError = (status: number, body: string) =>
    status === 401 ||
    status === 403 ||
    /embezzled|unauthorized|unauthenticated|invalid token|token expired|auth failed/i.test(body);

  let res = await call(RATE_LIMIT_PATH);

  // Expired access token: with the refresh half we can renew it — also when it
  // arrived inside a full cookie (the pair is re-inserted, other cookies stay).
  // A credential without a refresh half can't be renewed: re-paste instead.
  if (isAuthError(res.status, res.body)) {
    const pair = cred.token.includes('...') ? cred.token : cachedPair;
    if (!pair) {
      return fail(
        `Session expired (HTTP ${res.status}) and no refresh token in the credential — re-paste the cookie from platform.stepfun.com`,
      );
    }
    try {
      const fresh = await refreshToken(account, pair, cred.webid);
      refreshed.set(raw, fresh);
      persistPair(raw, fresh);
      cred = parseCredential(swapToken(raw, fresh), account.webid);
      res = await call(RATE_LIMIT_PATH);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (res.status !== 200) {
    return fail(`HTTP ${res.status} ${res.body.slice(0, 120).trim()}`.trim());
  }

  let data: RateLimitResponse;
  try {
    data = JSON.parse(res.body) as RateLimitResponse;
  } catch {
    return fail(`Unparseable response: ${res.body.slice(0, 120)}`);
  }

  const num = (v: Loose) => (v === undefined || v === null || v === '' ? NaN : Number(v));
  if (num(data.status) !== 1) {
    const msg =
      [data.message, data.desc]
        .map((s) => s?.trim())
        .find((s) => !!s && s !== 'success') ?? String(data.code ?? data.status ?? 'unknown');
    return fail(`Step Plan rate limit query failed: ${msg}`);
  }

  const limits: UsageLimit[] = [];
  const credit = data.plan_credit_rate_limit;
  if (isCreditPlan(data)) {
    const left = credit ? creditLeftRate(credit) : undefined;
    if (left === undefined) return fail('Credit plan reported no credit balance yet');
    limits.push({
      label: 'Monthly Credit',
      kind: 'monthly',
      percent: percentUsed(left),
      resetAt: isoFromUnix(credit?.subscription_credit_reset_time),
    });
  } else {
    const fiveLeft = num(data.five_hour_usage_left_rate);
    const weekLeft = num(data.weekly_usage_left_rate);
    if (!Number.isFinite(fiveLeft) || !Number.isFinite(weekLeft)) {
      return fail('Response carried no usage windows (and no credit pool)');
    }
    limits.push({
      label: '5h Window',
      kind: '5h',
      percent: percentUsed(fiveLeft),
      resetAt: isoFromUnix(data.five_hour_usage_reset_time),
    });
    limits.push({
      label: 'Weekly',
      kind: 'weekly',
      percent: percentUsed(weekLeft),
      resetAt: isoFromUnix(data.weekly_usage_reset_time),
    });
  }

  // The plan name is a nice-to-have: a failure here must not hide the usage.
  let planLabel: string | undefined;
  let planKey: string | undefined;
  try {
    const status = await call(PLAN_STATUS_PATH);
    if (status.status === 200) {
      const parsed = JSON.parse(status.body) as PlanStatusResponse;
      const name = parsed.subscription?.name?.trim();
      if (name) {
        planLabel = name;
        // An API-provided plan name: equal names mean equal window capacities,
        // which lets a multi-account merge be exact instead of estimated.
        planKey = name;
      }
    }
  } catch {
    /* usage data stands on its own */
  }

  return { ok: true, provider, label, summary: { planLabel, planKey, limits } };
}

/**
 * Exchange the paired `access...refresh` credential for a fresh access token.
 * Like the login/refresh calls of the console itself, the body is an empty
 * `{}` — the session travels entirely in the Oasis-Token header + cookie, and
 * protobuf-JSON bodies reject a stray field.
 */
async function refreshToken(account: StepFunAccount, pair: string, webid?: string) {
  const cred = parseCredential(pair, webid);
  const resp = await fetch(`${account.baseUrl}${REFRESH_PATH}`, {
    method: 'POST',
    body: '{}',
    headers: {
      'content-type': 'application/json',
      'oasis-appid': APP_ID,
      'oasis-platform': 'web',
      'oasis-webid': cred.webid || DEFAULT_WEBID,
      'user-agent': USER_AGENT,
      'Oasis-Token': cred.token,
      cookie: cred.webid ? `Oasis-Token=${cred.token}; Oasis-Webid=${cred.webid}` : `Oasis-Token=${cred.token}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Token refresh failed (HTTP ${resp.status}) — re-paste the cookie`);
  const json = JSON.parse(text) as { accessToken?: { raw?: string } | string; refreshToken?: { raw?: string } | string };
  const raw = (v: unknown) =>
    typeof v === 'string' ? v : typeof v === 'object' && v && 'raw' in v ? String((v as { raw: string }).raw) : '';
  const freshAccess = raw(json.accessToken);
  if (!freshAccess) throw new Error('Token refresh returned no access token — re-paste the cookie');
  const freshRefresh = raw(json.refreshToken);
  return freshRefresh ? `${freshAccess}...${freshRefresh}` : freshAccess;
}
