import { randomUUID } from 'node:crypto';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * Qwen Token Plan usage (千问 Token Plan, personal subscription).
 *
 * The plan has no API-key route: quota lives behind the platform console's
 * data gateway and answers only to a logged-in cookie session:
 *
 *   GET  https://platform-home.qianwenai.com/tool/user/info.json   -> data.secToken
 *   POST https://cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway
 *        &product=sfm_bailian&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/<api>
 *
 * with a form body carrying a nested JSON 'params' (Api / V / cornerstoneParam)
 * and the CSRF 'sec_token'. Three inner APIs are read:
 *
 *   usage        -> per1MonthPercentage + per1MonthResetTime (2026-09 shape;
 *                  older plans answer per1Week* / per5Hour*)
 *   quota-config -> monthly / weekly / five_hour totals per specCode
 *   subscription -> specCode (lite/standard/pro/essential), remainingDays
 *
 * The same package is visible in both the Qianwen console and the Bailian
 * console (bailian.console.aliyun.com/.../token-plan/personal); this provider
 * targets the Qianwen gateway, whose cookie is a .qianwenai.com session.
 *
 * QWEN_COOKIE is a strong credential: it never leaves this module and is never
 * echoed in a result, error or raw payload.
 */

const DEFAULT_GATEWAY_URL = 'https://cs-data.qianwenai.com/data/api.json';
const DEFAULT_INFO_URL = 'https://platform-home.qianwenai.com/tool/user/info.json';
const DASHBOARD_ORIGIN = 'https://platform-home.qianwenai.com';
const DASHBOARD_URL = 'https://platform-home.qianwenai.com/analytics/token-plan/individual';
const GATEWAY_ACTION = 'BroadScopeAspnGateway';
const GATEWAY_PRODUCT = 'sfm_bailian';
const API_PREFIX = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2';
const CONSOLE_SITE = 'QIANWENAI';
const REGION_ID = 'cn-beijing';
const TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS || 15000);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Env vars forming one account's config; the cookie is what marks it.
const ENV_VARS = ['QWEN_COOKIE', 'QWEN_SEC_TOKEN'];
const TRIGGER_VARS = ['QWEN_COOKIE'];

const PLAN_LABEL: Record<string, string> = {
  lite: 'Lite',
  standard: 'Standard',
  pro: 'Pro',
  essential: 'Essential',
};

type Loose = number | string | null | undefined;

interface QwenAccount {
  cookie?: string;
  secToken?: string;
  cookieEnv: string;
  secTokenEnv: string;
}

interface UsagePayload {
  per1MonthPercentage?: Loose;
  per1MonthResetTime?: Loose;
  per1WeekPercentage?: Loose;
  per1WeekResetTime?: Loose;
  per5HourPercentage?: Loose;
  per5HourResetTime?: Loose;
}

interface SubscriptionPayload {
  specCode?: string;
  remainingDays?: Loose;
  endTime?: Loose;
}

type QuotaPayload = Record<string, unknown>;

export function isConfigured(): boolean {
  return readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some((a) =>
    Boolean(a.env.QWEN_COOKIE),
  );
}

export function fetchQwenUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).map(
    ({ key, env }) => ({
      key,
      config: {
        cookie: env.QWEN_COOKIE,
        secToken: env.QWEN_SEC_TOKEN,
        cookieEnv: accountEnvName('QWEN_COOKIE', key),
        secTokenEnv: accountEnvName('QWEN_SEC_TOKEN', key),
      },
    }),
  );
  return fetchMultiAccount(accounts, fetchQwenAccount, { provider: 'qwen', label: 'Qwen' });
}

async function fetchQwenAccount(account: QwenAccount): Promise<ProviderResult> {
  const provider = 'qwen' as const;
  const label = 'Qwen';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  if (!account.cookie) {
    return fail(
      account.cookieEnv +
        ' not set — copy the Cookie header from a logged-in platform.qianwenai.com request',
    );
  }
  const cookie = normalizeCookie(account.cookie);
  if (!cookie) return fail(account.cookieEnv + ' is empty after trimming');

  try {
    const secToken =
      account.secToken || (await fetchSecToken(cookie)) || cookieValue(cookie, 'sec_token');

    const usage = await callGateway<UsagePayload>(cookie, secToken, 'usage');
    // quota-config is flaky upstream (documented timeouts) and subscription is
    // only needed for the plan name / specCode. Neither may take the usage
    // reading down with it: a ratio without a denominator is still a real,
    // official number.
    const [quota, subscription] = await Promise.all([
      callGateway<QuotaPayload>(cookie, secToken, 'quota-config').catch(() => null),
      callGateway<SubscriptionPayload>(cookie, secToken, 'subscription').catch(() => null),
    ]);

    const summary = buildSummary(usage, quota, subscription);
    if (summary.limits.length === 0) {
      return fail(
        'gateway answered but carried no per1Month/per1Week/per5Hour reading (plan or payload shape may have changed)',
      );
    }
    return { ok: true, provider, label, summary, raw: { usage, quota, subscription } };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Map the three gateway payloads into the dashboard's normalized rows. */
export function buildSummary(
  usage: UsagePayload,
  quota: QuotaPayload | null,
  subscription: SubscriptionPayload | null,
): { planLabel?: string; planKey?: string; limits: UsageLimit[] } {
  const specCode = typeof subscription?.specCode === 'string' ? subscription.specCode : '';
  const planKey = specCode || undefined;
  const planLabel = specCode ? (PLAN_LABEL[specCode.toLowerCase()] ?? specCode) : undefined;

  const specQuota =
    quota && specCode && isPlainObject(quota[specCode])
      ? (quota[specCode] as Record<string, unknown>)
      : quota;

  // A row exists only when the account actually returned that window's ratio.
  // quota-config alone is configuration (every tier ships all windows), not a
  // reading — showing its totals would invent a window the plan may not have.
  const limits: UsageLimit[] = [];
  const monthRatio = ratio(usage.per1MonthPercentage);
  if (monthRatio !== undefined) {
    limits.push(
      row('monthly', 'Monthly', monthRatio, number(specQuota?.monthly), usage.per1MonthResetTime),
    );
  }
  const weekRatio = ratio(usage.per1WeekPercentage);
  if (weekRatio !== undefined) {
    limits.push(
      row('weekly', 'Weekly', weekRatio, number(specQuota?.weekly), usage.per1WeekResetTime),
    );
  }
  const fiveRatio = ratio(usage.per5HourPercentage);
  if (fiveRatio !== undefined) {
    limits.push(
      row(
        '5h',
        '5h Window',
        fiveRatio,
        number(specQuota?.fiveHour ?? specQuota?.five_hour),
        usage.per5HourResetTime,
      ),
    );
  }

  // The current billing window leads: the badge and the first bar must report
  // the same window. Monthly plans (2026-09 onwards) outrank the old weekly
  // shape; if both are present, monthly is the billing period.
  const order = ['monthly', 'weekly', '5h'];
  limits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  return { planLabel, planKey, limits };
}

function row(
  kind: string,
  label: string,
  usedRatio: number,
  total?: number,
  resetAt?: Loose,
): UsageLimit {
  const percent = Math.max(0, Math.min(100, Math.round(usedRatio * 1000) / 10));
  const out: UsageLimit = { label, kind, percent, unit: 'Credits' };
  if (total !== undefined && total > 0) {
    out.total = total;
    out.used = Math.round(total * usedRatio * 10) / 10;
  }
  const iso = toIso(resetAt);
  if (iso) out.resetAt = iso;
  return out;
}

/** 0–1 ratio; the gateway's field is a fraction, never a 0–100 number. */
export function ratio(v: Loose): number | undefined {
  const n = number(v);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(1, n));
}

function number(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reset times arrive as epoch ms, epoch seconds, or a +08:00 wall clock. */
export function toIso(v: Loose): string | undefined {
  if (v === undefined || v === null) return undefined;
  const text = String(v).trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) {
    const raw = Number(text);
    if (raw <= 0) return undefined; // 0 is the console's "no reset" value
    return new Date(text.length <= 10 ? raw * 1000 : raw).toISOString();
  }
  const spaced = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (spaced) {
    const y = spaced[1];
    const mo = spaced[2];
    const d = spaced[3];
    const h = spaced[4];
    const mi = spaced[5];
    const s = spaced[6] ?? '00';
    const ms = Date.parse(y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + s + '+08:00');
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

interface GatewayEnvelope {
  code?: string | number;
  message?: string;
  msg?: string;
  successResponse?: boolean;
  data?: {
    errorCode?: string;
    errorMsg?: string;
    DataV2?: {
      data?:
        | ({
            success?: boolean;
            message?: string;
            errorMsg?: string;
            data?: unknown;
          } & Record<string, unknown>)
        | unknown;
    };
  };
}

/** Call one inner API through the console's BroadScopeAspnGateway. */
async function callGateway<T>(cookie: string, secToken: string | undefined, api: string): Promise<T> {
  const apiPath = API_PREFIX + '/' + api;
  const cna = cookieValue(cookie, 'cna');
  const params = {
    Api: apiPath,
    V: '1.0',
    Data: {
      cornerstoneParam: {
        feTraceId: randomUUID(),
        feURL: DASHBOARD_URL,
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        domain: 'platform-home.qianwenai.com',
        consoleSite: CONSOLE_SITE,
        userNickName: '',
        userPrincipalName: '',
        xsp_lang: 'zh-CN',
        ...(cna ? { 'X-Anonymous-Id': cna } : {}),
      },
    },
  };
  const query = new URLSearchParams({
    action: GATEWAY_ACTION,
    product: GATEWAY_PRODUCT,
    api: apiPath,
    _v: 'undefined',
  });
  const body = new URLSearchParams({
    product: GATEWAY_PRODUCT,
    action: GATEWAY_ACTION,
    region: REGION_ID,
    language: 'zh-CN',
    params: JSON.stringify(params),
    ...(secToken ? { sec_token: secToken } : {}),
  });

  const resp = await fetch(DEFAULT_GATEWAY_URL + '?' + query.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      cookie,
      origin: DASHBOARD_ORIGIN,
      referer: DASHBOARD_URL,
      'user-agent': USER_AGENT,
    },
    body: body.toString(),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(('HTTP ' + resp.status + ' ' + resp.statusText + snippet(text)).trim());
  }
  let payload: GatewayEnvelope;
  try {
    payload = JSON.parse(text) as GatewayEnvelope;
  } catch {
    throw new Error('console answered non-JSON — the session likely expired, re-paste QWEN_COOKIE');
  }
  const flat = JSON.stringify(payload).slice(0, 600);
  if (/NotAuthorised|NotLogined|Login\.NotLogin/i.test(flat)) {
    throw new Error(
      payload.data?.errorMsg ||
        payload.data?.errorCode ||
        'console gateway rejected the session — re-paste QWEN_COOKIE',
    );
  }
  const code = payload.code === undefined ? '' : String(payload.code);
  if (code !== '' && code !== '200' && payload.successResponse !== true) {
    throw new Error(payload.message || payload.msg || 'gateway code ' + code);
  }
  const data = unwrapGatewayData(payload.data?.DataV2?.data);
  if (!data) {
    throw new Error('response has no DataV2 payload (the console API may have changed)');
  }
  return data as T;
}

/**
 * The gateway nests the business payload by one or two envelopes depending on
 * the account/API: DataV2.data -> { ret, data: { code, msg, success, data } }.
 * Walk down the chain of plain-object data fields, stopping at the first
 * object that carries the payload itself. A success:false anywhere in the
 * chain is a real API error, not something to unwrap past.
 */
function unwrapGatewayData(value: unknown): Record<string, unknown> | undefined {
  let cur = value;
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(cur)) return undefined;
    if (cur.success === false) {
      const code = typeof cur.code === 'string' ? cur.code + ': ' : '';
      throw new Error(code + String(cur.message || cur.msg || cur.errorMsg || 'gateway business error'));
    }
    if (!isPlainObject(cur.data)) return cur;
    cur = cur.data;
  }
  return isPlainObject(cur) ? cur : undefined;
}

/** The CSRF token the gateway expects; a cookie value is the fallback. */
async function fetchSecToken(cookie: string): Promise<string | undefined> {
  try {
    const resp = await fetch(DEFAULT_INFO_URL, {
      headers: {
        accept: 'application/json',
        cookie,
        origin: DASHBOARD_ORIGIN,
        referer: DASHBOARD_URL,
        'user-agent': USER_AGENT,
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return undefined;
    const payload = (await resp.json()) as { data?: { secToken?: string }; secToken?: string };
    return payload.data?.secToken || payload.secToken;
  } catch {
    return undefined;
  }
}

/** Trim quotes / a leading "Cookie:" and collapse newlines from a pasted header. */
export function normalizeCookie(raw: string): string {
  return raw
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function cookieValue(cookie: string, name: string): string | undefined {
  const match = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(cookie);
  return match?.[1]?.trim();
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean ? ' · ' + clean.slice(0, 120) : '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
