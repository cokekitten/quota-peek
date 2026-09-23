import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, nextUtcMonthStart, poolSharePercent, readIndexedAccounts } from './accounts';

/**
 * Xiaomi MiMo (小米 MiMo 开放平台, platform.xiaomimimo.com) usage.
 *
 * The Token Plan's tp- API key only *spends* quota — usage and balance live
 * behind the web console session, in four ~24h cookies (api-platform_
 * serviceToken/slh/ph + userId) that Xiaomi provides no refresh endpoint for.
 * Two ways in:
 *
 *   MIMO_COOKIE            paste the console Cookie header; works for ~1 day,
 *                          then the card goes red and you re-paste.
 *   MIMO_USER_ID +         the Xiaomi Account SSO seed (account.xiaomi.com
 *   MIMO_PASS_TOKEN        cookies; long-lived, HttpOnly). When the 24h cookie
 *                          dies, the provider re-enacts the browser's silent
 *                          renewal — genLoginUrl → /pass/serviceLogin?_json
 *                          ( exchanging the seed, computing Xiaomi's
 *                          clientSign = base64(sha1("nonce=…&ssecurity")) ) →
 *                          the signed /sts callback, which re-issues the four
 *                          platform cookies. Rotated seeds and the fresh
 *                          platform cookie are cached in MIMO_SESSION_FILE
 *                          (0600, keyed by a seed fingerprint — multi-account
 *                          safe), the same pattern as the StepFun provider.
 *
 * Endpoints (all GET, console headers):
 *   /api/v1/tokenPlan/usage → plan_total_token / compensation_total_token
 *                            (套餐积分/补偿积分) + monthUsage (套餐月总量 —
 *                            the plan's billing window, not a calendar month;
 *                            plan_total_token is the same counter, so the
 *                            Monthly row wins and Token Plan is only a
 *                            fallback for payloads without monthUsage)
 *   /api/v1/tokenPlan/detail → currentPeriodEnd, when that window rolls over
 *                            ("有效期至 … (UTC)" on plan-manage); optional,
 *                            failures just leave rows without a countdown
 *   /api/v1/usage         → costUsage.currentMonthCost (当月消费金额,
 *                            the console's 账单及用量 page) — feeds the
 *                            消费/余额 money row together with the balance
 *   /api/v1/balance        → pay-as-you-go money (余额). Both money endpoints
 *                            are nice-to-have: failures are swallowed and
 *                            the row degrades or disappears.
 *
 * Credits are the plan's unit (community-measured ≈100 credits = ¥1; the raw
 * numbers are shown as-is).
 */

const DEFAULT_BASE_URL = 'https://platform.xiaomimimo.com';
const ACCOUNT_ORIGIN = 'https://account.xiaomi.com';
const USAGE_PATH = '/api/v1/tokenPlan/usage';
const DETAIL_PATH = '/api/v1/tokenPlan/detail';
const USAGE_SUMMARY_PATH = '/api/v1/usage';
const BALANCE_PATH = '/api/v1/balance';
const VERIFY_PATH = '/api/v1/userProfile';
const TIMEOUT_MS = Number(process.env.MIMO_TIMEOUT_MS || 15000);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
/** The four ~24h cookies the /sts callback issues. */
const PLATFORM_COOKIES = ['api-platform_serviceToken', 'api-platform_slh', 'api-platform_ph', 'userId'];

// Env vars forming one account's config; the cookie or the seed marks it.
const ENV_VARS = ['MIMO_COOKIE', 'MIMO_USER_ID', 'MIMO_PASS_TOKEN', 'MIMO_BASE_URL'];
const TRIGGER_VARS = ['MIMO_COOKIE', 'MIMO_USER_ID', 'MIMO_PASS_TOKEN'];

interface UsageItem {
  name?: string;
  used?: number | string;
  limit?: number | string;
  percent?: number | string; // 0–1
}

interface UsageResponse {
  code?: number;
  message?: string;
  data?: {
    usage?: { percent?: number | string; items?: UsageItem[] };
    monthUsage?: { percent?: number | string; items?: UsageItem[] };
  };
}

interface DetailResponse {
  code?: number;
  message?: string;
  data?: {
    planName?: string;
    currentPeriodEnd?: string;
    expired?: boolean;
  };
}

interface UsageSummaryResponse {
  code?: number;
  message?: string;
  data?: {
    costUsage?: { totalCost?: number | string; currentMonthCost?: number | string };
  };
}

interface BalanceResponse {
  code?: number;
  message?: string;
  data?: {
    balance?: string | number;
    cashBalance?: string | number;
    giftBalance?: string | number;
    currency?: string;
  };
}

interface Seed {
  userId: string;
  passToken: string;
}

/** Env values that mark an account as configured. */
export function isConfigured(): boolean {
  return readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some(
    (a) => Boolean(a.env.MIMO_COOKIE || (a.env.MIMO_USER_ID && a.env.MIMO_PASS_TOKEN)),
  );
}

export function fetchMimoUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).map(
    ({ key, env }) => {
      const seed =
        env.MIMO_USER_ID && env.MIMO_PASS_TOKEN
          ? { userId: env.MIMO_USER_ID, passToken: env.MIMO_PASS_TOKEN }
          : undefined;
      return {
        key,
        config: {
          cookie: env.MIMO_COOKIE,
          seed,
          cookieEnv: accountEnvName('MIMO_COOKIE', key),
          baseUrl: (env.MIMO_BASE_URL || process.env.MIMO_BASE_URL || DEFAULT_BASE_URL).replace(
            /\/$/,
            '',
          ),
        },
      };
    },
  );
  return fetchMultiAccount(accounts, fetchMimoAccount, {
    provider: 'mimo',
    label: 'MiMo',
  });
}

interface MimoAccount {
  cookie?: string;
  seed?: Seed;
  cookieEnv: string;
  baseUrl: string;
}

const num = (v: number | string | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const clampPercent = (v: number): number => Math.max(0, Math.min(100, v));

/**
 * Normalize `currentPeriodEnd` ("2026-10-21 23:59:59") to an ISO timestamp.
 * The value is UTC — the console renders it as "有效期至 … (UTC)" and parses
 * it with dayjs.utc — so a bare timestamp gets an explicit zone instead of
 * being read as local time. Garbage and already-elapsed deadlines yield
 * undefined: no countdown beats a wrong one.
 */
function periodEndIso(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > Date.now() ? new Date(ms).toISOString() : undefined;
}

/** Percent from used/limit when possible, else the API's own fraction. */
function itemPercent(item: { used?: unknown; limit?: unknown; percent?: unknown }): number {
  const used = num(item.used as number | string);
  const limit = num(item.limit as number | string);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return clampPercent(Math.round((used / limit) * 1000) / 10);
  }
  const p = num(item.percent as number | string);
  return Number.isFinite(p) ? clampPercent(Math.round(p * 1000) / 10) : 0;
}

// ------------------------------------------------------------ session cache

interface SessionEntry {
  /** Fresh platform Cookie header issued by the last /sts exchange. */
  platformCookie?: string;
  /** Rotated SSO seed (Xiaomi may rotate passToken on serviceLogin). */
  userId?: string;
  passToken?: string;
}

/**
 * Where renewed MiMo sessions survive. Without this, a container restart
 * forgets the renewed 24h cookie and the rotated seed — the stale seed in
 * .env may already have been spent, forcing a browser re-login. Our cache,
 * not a CLI credential file: 0600, keyed by a fingerprint of the original
 * env seed so a multi-account card never mixes accounts.
 */
function sessionFile(): string {
  return process.env.MIMO_SESSION_FILE || path.join(process.cwd(), '.mimo-session.json');
}

function seedFingerprint(seed: Seed): string {
  return createHash('sha256').update(`${seed.userId}\0${seed.passToken}`).digest('hex').slice(0, 16);
}

function readSessionMap(): Record<string, SessionEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as { accounts?: unknown };
    return parsed && typeof parsed.accounts === 'object' && parsed.accounts
      ? (parsed.accounts as Record<string, SessionEntry>)
      : {};
  } catch {
    return {}; // missing/unreadable/malformed → the pasted credentials stand
  }
}

function writeSessionEntry(fp: string, entry: SessionEntry) {
  const map = { ...readSessionMap(), [fp]: entry };
  try {
    fs.writeFileSync(sessionFile(), JSON.stringify({ accounts: map, savedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
  } catch {
    /* read-only mount or unwritable path: keep serving from memory */
  }
}

// ------------------------------------------------------------------- fetch

async function fetchMimoAccount(account: MimoAccount): Promise<ProviderResult> {
  const provider = 'mimo' as const;
  const label = 'MiMo';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  // Cached session (rotated seed + fresh cookie) beats the raw env values.
  const cached = account.seed ? readSessionMap()[seedFingerprint(account.seed)] : undefined;
  let seed: Seed | undefined = cached?.userId && cached?.passToken
    ? { userId: cached.userId, passToken: cached.passToken }
    : account.seed;
  let platformCookie = cached?.platformCookie || account.cookie;
  if (!platformCookie && !seed) {
    return fail(
      `${account.cookieEnv} not set — paste the Cookie header from platform.xiaomimimo.com, or set MIMO_USER_ID + MIMO_PASS_TOKEN for auto-refresh`,
    );
  }
  if (!platformCookie && seed) {
    // Seed-only account that never logged in yet: run the SSO exchange now.
    try {
      const fresh = await refreshSession(seed, account.baseUrl);
      if (fresh.rotatedSeed) seed = fresh.rotatedSeed;
      platformCookie = fresh.cookie;
      if (account.seed) {
        writeSessionEntry(seedFingerprint(account.seed), {
          platformCookie,
          userId: seed.userId,
          passToken: seed.passToken,
        });
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const call = async (path: string) => {
    const resp = await fetch(`${account.baseUrl}${path}`, {
      headers: {
        Accept: 'application/json',
        Cookie: platformCookie!,
        Referer: `${account.baseUrl}/console/plan-manage`,
        'User-Agent': USER_AGENT,
        'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      },
      redirect: 'manual', // an expired console session 302s to the login page
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: resp.status, body: await resp.text() };
  };

  let res = await call(USAGE_PATH);

  // Expired 24h cookie: re-enact the browser's silent renewal via the seed.
  if (isAuthFailure(res.status, res.body) && seed) {
    try {
      const fresh = await refreshSession(seed, account.baseUrl);
      if (fresh.rotatedSeed) seed = fresh.rotatedSeed;
      platformCookie = fresh.cookie;
      if (account.seed) {
        writeSessionEntry(seedFingerprint(account.seed), {
          platformCookie,
          userId: seed.userId,
          passToken: seed.passToken,
        });
      }
      res = await call(USAGE_PATH);
    } catch (err) {
      return fail(
        `Cookie expired and auto-refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (isAuthFailure(res.status, res.body)) {
    return fail(
      'Cookie expired or rejected — re-paste MIMO_COOKIE, or set MIMO_USER_ID + MIMO_PASS_TOKEN (account.xiaomi.com cookies) for automatic renewal',
    );
  }
  if (res.status !== 200) return fail(`HTTP ${res.status} ${res.body.slice(0, 120)}`.trim());

  let data: UsageResponse;
  try {
    data = JSON.parse(res.body) as UsageResponse;
  } catch {
    return fail(`Unparseable response: ${res.body.slice(0, 120)}`);
  }
  if (num(data.code) !== 0) {
    const msg = data.message?.trim() || `code ${data.code ?? 'unknown'}`;
    return fail(`Usage query failed: ${msg}`);
  }

  const items = data.data?.usage?.items ?? [];
  const planItem = items.find((i) => i.name === 'plan_total_token');
  const compItem = items.find((i) => i.name === 'compensation_total_token');
  const monthItem = data.data?.monthUsage?.items?.[0];

  const limits: UsageLimit[] = [];
  const pushItem = (
    item: UsageItem | undefined,
    limitLabel: string,
    kind: string,
    skipZeroLimit: boolean,
  ) => {
    if (!item) return;
    const used = num(item.used);
    const limit = num(item.limit);
    // Skip rows that carry an explicit zero quota (e.g. no compensation
    // granted); a *missing* limit is unknown, not zero — keep it percent-only.
    if (skipZeroLimit && Number.isFinite(limit) && limit <= 0) return;
    const row: UsageLimit = {
      label: limitLabel,
      kind,
      percent: itemPercent(item),
      unit: 'cr',
    };
    if (Number.isFinite(used)) row.used = used;
    if (Number.isFinite(limit) && limit > 0) {
      row.total = limit;
    } else {
      // No limit → percent is all we have; don't fake absolutes.
      row.used = undefined;
    }
    limits.push(row);
  };

  if (!monthItem) pushItem(planItem, 'Token Plan', 'plan', true);
  pushItem(compItem, 'Compensation', 'comp', true);
  pushItem(monthItem, 'Monthly', 'monthly', false);
  if (limits.length === 0) {
    return fail('Usage response carried no plan/month items (no active Token Plan?)');
  }
  // tokenPlan/detail carries what the usage payload lacks: the plan name
  // (the card header tag) and when the billing window rolls over — the
  // console's "有效期至 … (UTC)" line. Decorative: failures just leave both
  // unset rather than guessing.
  let planName: string | undefined;
  const monthly = limits.find((l) => l.kind === 'monthly');
  try {
    const det = await call(DETAIL_PATH);
    if (det.status === 200) {
      const parsed = JSON.parse(det.body) as DetailResponse;
      planName = parsed.data?.planName?.trim() || undefined;
      // The monthly window is the plan's billing cycle and refills when the
      // period rolls over — never a calendar month.
      if (monthly && num(monthItem?.limit as number | string) > 0) {
        const iso = periodEndIso(parsed.data?.currentPeriodEnd);
        if (iso) monthly.resetAt = iso;
      }
    }
  } catch {
    /* decorative — the rows already stand on their own */
  }

  // ---- money: 余额 + 当月消费 (a DeepSeek-style 消费/余额 row) -------------
  let balance = NaN;
  let currency = '';
  try {
    const bal = await call(BALANCE_PATH);
    if (bal.status === 200) {
      const parsed = JSON.parse(bal.body) as BalanceResponse;
      balance = num(parsed.data?.balance);
      currency = parsed.data?.currency ?? '';
    }
  } catch {
    /* money is decorative — the credit rows already stand */
  }
  let spend = NaN;
  try {
    const use = await call(USAGE_SUMMARY_PATH);
    if (use.status === 200) {
      const parsed = JSON.parse(use.body) as UsageSummaryResponse;
      spend = num(parsed.data?.costUsage?.currentMonthCost);
    }
  } catch {
    /* same */
  }
  const unit = currency === 'USD' ? '$' : '¥';
  const haveSpend = Number.isFinite(spend) && spend >= 0;
  const haveBalance = Number.isFinite(balance) && balance > 0;
  if (haveSpend && haveBalance) {
    limits.push({
      label: 'Spend / Balance',
      kind: 'spend',
      percent: poolSharePercent(spend, balance),
      used: spend,
      total: balance,
      unit,
      // The month window (UTC buckets) rolls over at the month boundary —
      // anchors the countdown and the over/under pace delta.
      resetAt: nextUtcMonthStart(),
    });
  } else if (haveBalance) {
    limits.push({ label: 'Balance', kind: 'balance', percent: 0, used: balance, unit });
  } else if (haveSpend) {
    limits.push({
      label: 'Spend / Balance',
      kind: 'spend',
      percent: 0,
      used: spend,
      unit,
      resetAt: nextUtcMonthStart(),
    });
  }

  return { ok: true, provider, label, summary: { planLabel: planName, limits } };
}

/** 302 (redirect to login), 401/403, or a JSON envelope with code 401. */
function isAuthFailure(status: number, body: string): boolean {
  if (status === 302 || status === 401 || status === 403) return true;
  try {
    const json = JSON.parse(body) as { code?: unknown };
    return json?.code === 401 || json?.code === '401';
  } catch {
    return false;
  }
}

// -------------------------------------------------------- Xiaomi SSO renewal

interface RefreshedSession {
  cookie: string;
  rotatedSeed?: Seed;
}

/**
 * Exchange the long-lived Xiaomi Account seed for a fresh set of ~24h
 * platform cookies. Mirrors what the browser does silently:
 *   1. genLoginUrl → a signed account.xiaomi.com/pass/serviceLogin URL
 *      (sid=api-platform, callback=our /sts)
 *   2. serviceLogin?_json=true with the seed cookies → {code, location,
 *      nonce, ssecurity, possibly rotated userId/passToken}
 *   3. clientSign = base64(sha1("nonce=…&ssecurity")) appended to location
 *   4. GET the signed /sts URL → Set-Cookie re-issues the four platform
 *      cookies; verified against /api/v1/userProfile.
 */
async function refreshSession(seed: Seed, baseUrl: string): Promise<RefreshedSession> {
  // 1. signed login URL from the platform itself (also the interactive URL
  //    a human would use, so we never craft account URLs ourselves).
  const gen = await fetch(`${baseUrl}/api/v1/genLoginUrl?currentPath=${encodeURIComponent(VERIFY_PATH)}`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let loginUrl: string | undefined = gen.headers.get('location') ?? undefined;
  if (!loginUrl) {
    try {
      const json = JSON.parse(await gen.text()) as { loginUrl?: string };
      loginUrl = json.loginUrl;
    } catch {
      /* handled below */
    }
  }
  if (!loginUrl) throw new Error('platform did not return a login URL');
  const login = new URL(loginUrl);
  if (login.origin !== ACCOUNT_ORIGIN || login.pathname !== '/pass/serviceLogin') {
    throw new Error('unexpected login URL shape — aborting');
  }
  if (login.searchParams.get('sid') !== 'api-platform') {
    throw new Error('unexpected login sid — aborting');
  }
  const callback = login.searchParams.get('callback');
  if (!callback) throw new Error('login URL missing callback — aborting');
  const cb = new URL(callback);
  if (cb.origin !== baseUrl || cb.pathname !== '/sts') {
    throw new Error('unexpected login callback — aborting');
  }

  // 2. exchange the seed at the account SSO (JSON flavor).
  login.searchParams.set('_json', 'true');
  const auth = await fetch(login, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Cookie: `userId=${seed.userId}; passToken=${seed.passToken}`,
    },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (auth.status >= 400) {
    throw new Error('Xiaomi account rejected the saved session — re-paste MIMO_USER_ID/MIMO_PASS_TOKEN');
  }
  let payload: Record<string, unknown>;
  try {
    const text = (await auth.text()).trim();
    payload = JSON.parse(
      text.startsWith('&&&START&&&') ? text.slice('&&&START&&&'.length) : text,
    ) as Record<string, unknown>;
  } catch {
    throw new Error('Xiaomi account requires interactive sign-in (captcha/MFA?) — re-paste the seed cookies');
  }
  if (payload.code !== 0 && payload.code !== '0') {
    throw new Error('Xiaomi account session expired — re-paste MIMO_USER_ID/MIMO_PASS_TOKEN');
  }
  const rotatedSeed =
    typeof payload.userId === 'string' && typeof payload.passToken === 'string' && payload.passToken
      ? { userId: payload.userId, passToken: payload.passToken }
      : undefined;

  // 3. sign the STS URL the way the web client does.
  const sts = new URL(String(payload.location));
  if (sts.origin !== baseUrl || sts.pathname !== '/sts') {
    throw new Error('unexpected STS URL — aborting');
  }
  if (!sts.searchParams.has('clientSign') && !sts.searchParams.has('_ssign')) {
    const nonce = String(payload.nonce ?? '');
    const ssecurity = String(payload.ssecurity ?? '');
    if (!nonce || !ssecurity) throw new Error('account response cannot be signed — aborting');
    const digest = createHash('sha1').update(`nonce=${nonce}&${ssecurity}`).digest('base64');
    sts.searchParams.set('clientSign', digest);
  }

  // 4. hit /sts: the four ~24h platform cookies arrive as Set-Cookie.
  const stsResp = await fetch(sts, {
    headers: { Accept: 'text/html,*/*', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (stsResp.status >= 400) throw new Error(`STS returned HTTP ${stsResp.status}`);
  const jar = new Map<string, string>();
  for (const raw of stsResp.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const missing = PLATFORM_COOKIES.filter((name) => !jar.has(name));
  if (missing.length) throw new Error(`STS did not issue platform cookies (${missing.join(', ')})`);
  const cookie = PLATFORM_COOKIES.map((name) => `${name}=${jar.get(name)}`).join('; ');

  // 5. verify the new session actually authenticates.
  const probe = await fetch(`${baseUrl}${VERIFY_PATH}`, {
    headers: { Accept: 'application/json', Cookie: cookie, 'User-Agent': USER_AGENT },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (isAuthFailure(probe.status, await probe.text())) {
    throw new Error('platform rejected the renewed session — re-paste the seed cookies');
  }

  return { cookie, rotatedSeed };
}
