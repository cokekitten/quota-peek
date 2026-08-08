import crypto from 'node:crypto';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * Volcengine Ark Coding Plan (火山方舟) usage via the control-plane
 * GetAFPUsage API: POST ark.cn-beijing.volcengineapi.com with an empty body,
 * signed with the account's AK/SK using Volcengine's HMAC-SHA256 V4 scheme
 * (AWS SigV4-style: kSigning = HMAC(HMAC(HMAC(HMAC(SK, date), region),
 * service), "request")).
 *
 * Returns PlanType (Small/Medium/Large/Max) plus four quota windows —
 * five-hour / daily / weekly / monthly, each { Quota, Used, SubscribeTime,
 * ResetTime }. The card renders the 5h + weekly slots; the full response is
 * kept in `raw`. Extra accounts: VOLC_ACCESS_KEY_2 / VOLC_SECRET_KEY_2, …
 */

const HOST = process.env.VOLC_HOST || 'ark.cn-beijing.volcengineapi.com';
const REGION = process.env.VOLC_REGION || 'cn-beijing';
const SERVICE = 'ark';
const API_VERSION = '2024-01-01';
const ACTION = 'GetAFPUsage';
const TIMEOUT_MS = Number(process.env.VOLC_TIMEOUT_MS || 15000);

interface VolcQuota {
  Quota?: number;
  Used?: number;
  SubscribeTime?: number;
  ResetTime?: number;
}

interface VolcUsageResponse {
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
  Result?: {
    PlanType?: string;
    AFPFiveHour?: VolcQuota;
    AFPDaily?: VolcQuota;
    AFPWeekly?: VolcQuota;
    AFPMonthly?: VolcQuota;
  };
}

interface VolcAccount {
  accessKey?: string;
  secretKey?: string;
  akEnv: string;
  skEnv: string;
}

export function fetchVolcengineUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({
    vars: ['VOLC_ACCESS_KEY', 'VOLC_SECRET_KEY'],
  }).map(({ key, env }) => ({
    key,
    config: {
      accessKey: env.VOLC_ACCESS_KEY,
      secretKey: env.VOLC_SECRET_KEY,
      akEnv: accountEnvName('VOLC_ACCESS_KEY', key),
      skEnv: accountEnvName('VOLC_SECRET_KEY', key),
    },
  }));
  return fetchMultiAccount(accounts, fetchVolcAccount, {
    provider: 'volcengine',
    label: 'Volcengine',
  });
}

async function fetchVolcAccount(account: VolcAccount): Promise<ProviderResult> {
  const provider = 'volcengine' as const;
  const label = 'Volcengine';
  if (!account.accessKey || !account.secretKey) {
    return {
      ok: false,
      provider,
      label,
      error: `${account.akEnv} / ${account.skEnv} not set (火山引擎控制台 → 密钥管理)`,
    };
  }

  try {
    const body = '{}';
    const headers = signVolcRequest({
      accessKey: account.accessKey,
      secretKey: account.secretKey,
      host: HOST,
      region: REGION,
      service: SERVICE,
      action: ACTION,
      version: API_VERSION,
      body,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(`https://${HOST}/?Action=${ACTION}&Version=${API_VERSION}`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return { ok: false, provider, label, error: `HTTP ${resp.status} ${resp.statusText}` };
    }

    const data = (await resp.json()) as VolcUsageResponse;
    const apiErr = data.ResponseMetadata?.Error;
    if (apiErr?.Code) {
      return {
        ok: false,
        provider,
        label,
        error: `${apiErr.Code}: ${apiErr.Message || 'API error'}`,
        raw: data as unknown,
      };
    }

    const result = data.Result;
    if (!result?.PlanType) {
      // Signed request succeeded, but this account carries no Coding Plan.
      return {
        ok: false,
        provider,
        label,
        error: 'No Coding Plan subscription on this account (PlanType empty)',
        raw: data as unknown,
      };
    }

    const limits: UsageLimit[] = [];
    const fiveHour = quotaLimit(result.AFPFiveHour, '5h Window', '5h');
    if (fiveHour) limits.push(fiveHour);
    const weekly = quotaLimit(result.AFPWeekly, 'Weekly', 'weekly');
    if (weekly) limits.push(weekly);

    return {
      ok: true,
      provider,
      label,
      summary: {
        planLabel: result.PlanType,
        limits,
        // Daily/monthly windows ride along for future UI; raw has everything.
        daily: result.AFPDaily ?? null,
        monthly: result.AFPMonthly ?? null,
      },
      raw: data as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      label,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map { Quota, Used, ResetTime } into a UsageLimit (absolute numbers → exact merges). */
function quotaLimit(q: VolcQuota | undefined, label: string, kind: string): UsageLimit | null {
  if (!q) return null;
  const total = Number(q.Quota);
  const used = Number(q.Used);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null;
  const out: UsageLimit = {
    label,
    kind,
    percent: Math.max(0, Math.min(100, Math.round((used / total) * 100))),
    used,
    total,
  };
  // ResetTime is unix seconds; 0 means "no schedule" (e.g. unsubscribed).
  if (q.ResetTime && q.ResetTime > 0) {
    out.resetAt = new Date(q.ResetTime * 1000).toISOString();
  }
  return out;
}

export interface VolcSignInput {
  accessKey: string;
  secretKey: string;
  host: string;
  region: string;
  service: string;
  action: string;
  version: string;
  body: string;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

/** Volcengine V4 signing → the full header set for the POST. Exported for tests. */
export function signVolcRequest(input: VolcSignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const xDate =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const shortDate = xDate.slice(0, 8);

  const bodyHash = crypto.createHash('sha256').update(input.body).digest('hex');
  const query = `Action=${input.action}&Version=${input.version}`;
  const canonicalHeaders =
    `host:${input.host}\n` + `x-content-sha256:${bodyHash}\n` + `x-date:${xDate}\n`;
  const signedHeaders = 'host;x-content-sha256;x-date';
  const canonicalRequest = [
    'POST',
    '/',
    query,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const scope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: crypto.BinaryLike | crypto.KeyObject, data: string) =>
    crypto.createHmac('sha256', key).update(data).digest();
  const kSigning = hmac(
    hmac(hmac(hmac(input.secretKey, shortDate), input.region), input.service),
    'request',
  );
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Date': xDate,
    'X-Content-Sha256': bodyHash,
    Authorization:
      `HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
