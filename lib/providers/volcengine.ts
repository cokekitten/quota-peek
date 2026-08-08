import crypto from 'node:crypto';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * Volcengine Ark Coding Plan (火山方舟) usage via the control plane, signed
 * with the account's AK/SK using Volcengine's HMAC-SHA256 V4 scheme
 * (AWS SigV4-style: kSigning = HMAC(HMAC(HMAC(HMAC(SK, date), region),
 * service), "request")).
 *
 * Two usage actions, tried in order:
 * 1. GetCodingPlanUsage — the current Coding Plan product: { Status,
 *    QuotaUsage: [{ Level: session|weekly|monthly, Percent, ResetTimestamp,
 *    Cap }] }. Percent-based only (Cap is a % scale), so multi-account merges
 *    are means flagged ≈ estimated.
 * 2. GetAFPUsage — the older Agent Plan product: PlanType plus { Quota, Used,
 *    ResetTime } per window (absolute numbers → exact merges). Used as a
 *    fallback when the account's plan predates GetCodingPlanUsage
 *    (InvalidActionOrVersion) or returns nothing.
 *
 * The card renders the 5h + weekly slots; monthly rides along in summary.
 * Extra accounts: VOLC_ACCESS_KEY_2 / VOLC_SECRET_KEY_2, …
 */

const HOST = process.env.VOLC_HOST || 'ark.cn-beijing.volcengineapi.com';
const REGION = process.env.VOLC_REGION || 'cn-beijing';
const SERVICE = 'ark';
const API_VERSION = '2024-01-01';
const TIMEOUT_MS = Number(process.env.VOLC_TIMEOUT_MS || 15000);

interface VolcError {
  Code?: string;
  Message?: string;
}

interface CodingPlanQuota {
  Level?: string;
  Percent?: number;
  ResetTimestamp?: number;
  Cap?: number;
}

interface CodingPlanResponse {
  ResponseMetadata?: { Error?: VolcError };
  Result?: {
    Status?: string;
    UpdateTimestamp?: number;
    QuotaUsage?: CodingPlanQuota[];
  };
}

interface AfpQuota {
  Quota?: number;
  Used?: number;
  SubscribeTime?: number;
  ResetTime?: number;
}

interface AfpUsageResponse {
  ResponseMetadata?: { Error?: VolcError };
  Result?: {
    PlanType?: string;
    AFPFiveHour?: AfpQuota;
    AFPDaily?: AfpQuota;
    AFPWeekly?: AfpQuota;
    AFPMonthly?: AfpQuota;
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

  const call = async (action: string): Promise<{ json: any } | { error: string }> => {
    try {
      const body = '{}';
      const headers = signVolcRequest({
        accessKey: account.accessKey!,
        secretKey: account.secretKey!,
        host: HOST,
        region: REGION,
        service: SERVICE,
        action,
        version: API_VERSION,
        body,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const resp = await fetch(`https://${HOST}/?Action=${action}&Version=${API_VERSION}`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) return { error: `HTTP ${resp.status} ${resp.statusText}` };
      return { json: await resp.json() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  // 1) Current Coding Plan product.
  const coding = await call('GetCodingPlanUsage');
  if ('json' in coding) {
    const data = coding.json as CodingPlanResponse;
    const apiErr = data.ResponseMetadata?.Error;
    const usage = data.Result?.QuotaUsage ?? [];
    if (!apiErr?.Code && usage.length > 0) {
      const limits: UsageLimit[] = [];
      for (const q of usage) {
        if (typeof q.Percent !== 'number') continue;
        const percent = Math.max(0, Math.min(100, Math.round(q.Percent)));
        const resetAt = q.ResetTimestamp ? new Date(q.ResetTimestamp * 1000).toISOString() : undefined;
        if (q.Level === 'session') limits.push({ label: '5h Window', kind: '5h', percent, resetAt });
        else if (q.Level === 'weekly') limits.push({ label: 'Weekly', kind: 'weekly', percent, resetAt });
        else if (q.Level === 'monthly') limits.push({ label: 'Monthly', kind: 'monthly', percent, resetAt });
      }
      return {
        ok: true,
        provider,
        label,
        summary: {
          // GetCodingPlanUsage exposes no tier name — status is the only signal.
          planLabel: 'Coding Plan',
          limits,
        },
        raw: data as unknown,
      };
    }
    // InvalidActionOrVersion → account's plan predates this action; fall
    // through to the AFP product. Any other error also falls through so the
    // fallback gets its say before we give up.
  }

  // 2) Older Agent Plan product (absolute quota numbers).
  const afp = await call('GetAFPUsage');
  if ('json' in afp) {
    const data = afp.json as AfpUsageResponse;
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
    if (result?.PlanType) {
      const limits: UsageLimit[] = [];
      const fiveHour = afpQuotaLimit(result.AFPFiveHour, '5h Window', '5h');
      if (fiveHour) limits.push(fiveHour);
      const weekly = afpQuotaLimit(result.AFPWeekly, 'Weekly', 'weekly');
      if (weekly) limits.push(weekly);
      const monthly = afpQuotaLimit(result.AFPMonthly, 'Monthly', 'monthly');
      if (monthly) limits.push(monthly);
      return {
        ok: true,
        provider,
        label,
        summary: {
          planLabel: result.PlanType,
          limits,
          daily: result.AFPDaily ?? null,
          monthly: result.AFPMonthly ?? null,
        },
        raw: data as unknown,
      };
    }
    // Signed request succeeded, but this account carries no plan on either API.
    return {
      ok: false,
      provider,
      label,
      error: 'No Coding Plan subscription on this account',
      raw: data as unknown,
    };
  }

  return { ok: false, provider, label, error: afp.error ?? ('error' in coding ? coding.error : 'unknown') };
}

/** Map AFP { Quota, Used, ResetTime } into a UsageLimit (absolute → exact merges). */
function afpQuotaLimit(q: AfpQuota | undefined, label: string, kind: string): UsageLimit | null {
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
