import type { ProviderResult, UsageLimit } from './types';
import {
  accountEnvName,
  fetchMultiAccount,
  nextUtcDayStart,
  nextUtcMonthStart,
  nextUtcWeekStart,
  poolSharePercent,
  readIndexedAccounts,
} from './accounts';

/**
 * OpenRouter (openrouter.ai) — a money card keyed by plain API keys.
 *
 * Two credential kinds (both `sk-or-v1-…`, both Bearer — the simplest
 * provider here: no session, no signing):
 *
 *   OPENROUTER_API_KEY(_N)      the regular key you call models with
 *     GET /api/v1/key → that key's own numbers only: usage_monthly (当月,
 *     UTC) and its optional spending cap (limit / limit_remaining /
 *     limit_reset). A regular key cannot see the wallet.
 *
 *   OPENROUTER_MANAGEMENT_KEY   created under /settings/management-keys;
 *     cannot call models at all
 *     GET /api/v1/credits → { total_credits, total_usage } — the wallet:
 *     balance = purchased − spent, across every key on the account.
 *
 * With both, the card shows the 消费/余额 shape (Spend / Balance: month
 * spend over the wallet balance, pool-share percent, UTC month rollover)
 * plus a Key Limit bar per capped key. Regular keys alone degrade to a bare
 * Month Spend amount + Key Limit; the management key alone shows the
 * cumulative Usage / Balance.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai';
const KEY_PATH = '/api/v1/key';
const CREDITS_PATH = '/api/v1/credits';
const ANALYTICS_PATH = '/api/v1/analytics/query';
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 15000);
const MGMT_VAR = 'OPENROUTER_MANAGEMENT_KEY';

// Env vars forming one account's config; the API key marks it.
const ENV_VARS = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'];
const TRIGGER_VARS = ['OPENROUTER_API_KEY'];

/** Wire format of GET /api/v1/key (snake_case inside a data envelope). */
interface KeyData {
  label?: string;
  usage?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  disabled?: boolean;
}

interface KeyResponse {
  error?: { message?: string };
  data?: KeyData;
}

interface CreditsResponse {
  data?: { total_credits?: number | string; total_usage?: number | string };
}

interface OrAccount {
  apiKey: string;
  apiKeyEnv: string;
  baseUrl: string;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Money to cents — balances are differences of two reported amounts. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Env values that mark the provider as configured. */
export function isConfigured(): boolean {
  return (
    Boolean(process.env[MGMT_VAR]) ||
    readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some((a) =>
      Boolean(a.env.OPENROUTER_API_KEY),
    )
  );
}

export async function fetchOpenrouterUsage(): Promise<ProviderResult> {
  const provider = 'openrouter' as const;
  const label = 'OpenRouter';
  const baseUrl = (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const keys = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS })
    .filter(({ env }) => Boolean(env.OPENROUTER_API_KEY))
    .map(({ key, env }) => ({
      key,
      config: {
        apiKey: env.OPENROUTER_API_KEY as string,
        apiKeyEnv: accountEnvName('OPENROUTER_API_KEY', key),
        baseUrl: (env.OPENROUTER_BASE_URL || baseUrl).replace(/\/$/, ''),
      },
    }));

  const [keysResult, wallet, monthSpend] = await Promise.all([
    keys.length
      ? fetchMultiAccount(keys, fetchOpenrouterAccount, { provider, label })
      : Promise.resolve(undefined),
    fetchWallet(process.env[MGMT_VAR], baseUrl),
    fetchMonthSpend(process.env[MGMT_VAR], baseUrl),
  ]);

  // No regular keys: the management key's own view — the month over the
  // wallet when analytics answers, the cumulative pool otherwise.
  if (!keysResult) {
    if (monthSpend !== undefined && wallet) {
      return {
        ok: true,
        provider,
        label,
        summary: {
          limits: [
            {
              label: 'Spend / Balance',
              kind: 'spend',
              percent: poolSharePercent(monthSpend, wallet.balance),
              used: monthSpend,
              total: wallet.balance,
              unit: '$',
              resetAt: nextUtcMonthStart(),
            },
          ],
        },
      };
    }
    if (monthSpend !== undefined) {
      return {
        ok: true,
        provider,
        label,
        summary: {
          limits: [
            {
              label: 'Month Spend',
              kind: 'balance',
              percent: 0,
              used: monthSpend,
              unit: '$',
              resetAt: nextUtcMonthStart(),
            },
          ],
        },
      };
    }
    if (wallet) {
      return {
        ok: true,
        provider,
        label,
        summary: {
          limits: [
            {
              label: 'Usage / Balance',
              kind: 'spend',
              percent: poolSharePercent(wallet.spent, wallet.balance),
              used: wallet.spent,
              total: wallet.balance,
              unit: '$',
            },
          ],
        },
      };
    }
    return {
      ok: false,
      provider,
      label,
      error: `neither OPENROUTER_API_KEY nor ${MGMT_VAR} answered — nothing to show`,
    };
  }
  if (!keysResult.ok || (!wallet && monthSpend === undefined)) return keysResult;

  // Fold the account-level numbers into the combined money row: the whole
  // account's month spend (analytics covers every key, even unconfigured
  // ones — falling back to the configured keys' own usage_monthly) over the
  // wallet balance. Per-account views keep their own numbers (the wallet is
  // shared, so summing it per account would double-count).
  const limits = (keysResult.summary?.limits ?? []).map((l) => {
    if (l.label !== 'Month Spend' || l.kind !== 'balance') return l;
    const used = monthSpend ?? l.used ?? 0;
    if (!wallet) return { ...l, used };
    return {
      label: 'Spend / Balance',
      kind: 'spend',
      percent: poolSharePercent(used, wallet.balance),
      used,
      total: wallet.balance,
      unit: '$',
      resetAt: l.resetAt,
    };
  });
  return { ...keysResult, summary: { ...keysResult.summary!, limits } };
}

/**
 * The account's month spend (当月, UTC) straight from analytics — every key
 * on the account, not just the configured ones. undefined when the
 * management key is missing or analytics declines; 0 is a real empty month.
 */
async function fetchMonthSpend(
  mgmtKey: string | undefined,
  baseUrl: string,
): Promise<number | undefined> {
  if (!mgmtKey) return undefined;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  try {
    const resp = await fetch(`${baseUrl}${ANALYTICS_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mgmtKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metrics: ['total_usage'],
        granularity: 'day',
        time_range: { start, end: now.toISOString() },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return undefined;
    const parsed = (await resp.json()) as {
      data?: { data?: Array<{ total_usage?: number | string }> };
    };
    const rows = parsed.data?.data;
    if (!Array.isArray(rows)) return undefined;
    let sum = 0;
    for (const row of rows) sum += num(row.total_usage) || 0;
    return round2(sum);
  } catch {
    return undefined;
  }
}

/** The account wallet via the Management key: spent + remaining, in USD. */
async function fetchWallet(
  mgmtKey: string | undefined,
  baseUrl: string,
): Promise<{ spent: number; balance: number } | undefined> {
  if (!mgmtKey) return undefined;
  try {
    const resp = await fetch(`${baseUrl}${CREDITS_PATH}`, {
      headers: { Authorization: `Bearer ${mgmtKey}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return undefined; // decorative — the rows degrade without it
    const parsed = (await resp.json()) as CreditsResponse;
    const spent = num(parsed.data?.total_usage);
    const credits = num(parsed.data?.total_credits);
    if (!Number.isFinite(spent) || !Number.isFinite(credits)) return undefined;
    return { spent: round2(spent), balance: Math.max(0, round2(credits - spent)) };
  } catch {
    return undefined;
  }
}

/** The key cap's rollover — OpenRouter windows are UTC (day / Mon–Sun / month). */
function capWindow(cadence: string | null | undefined): { kind: string; resetAt?: string } {
  switch ((cadence ?? '').trim().toLowerCase()) {
    case 'daily':
      return { kind: 'daily', resetAt: nextUtcDayStart() };
    case 'weekly':
      return { kind: 'weekly', resetAt: nextUtcWeekStart() };
    case 'monthly':
      return { kind: 'monthly', resetAt: nextUtcMonthStart() };
    default:
      return { kind: 'cap' }; // lifetime cap (or unknown cadence): no rollover
  }
}

async function fetchOpenrouterAccount(account: OrAccount): Promise<ProviderResult> {
  const provider = 'openrouter' as const;
  const label = 'OpenRouter';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  let status: number;
  let body: string;
  try {
    const resp = await fetch(`${account.baseUrl}${KEY_PATH}`, {
      headers: { Authorization: `Bearer ${account.apiKey}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = resp.status;
    body = await resp.text();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (status === 401 || status === 403) {
    return fail(
      `key rejected (HTTP ${status}) — check ${account.apiKeyEnv} (openrouter.ai/settings/keys)`,
    );
  }
  if (status !== 200) return fail(`HTTP ${status} ${body.slice(0, 120)}`.trim());

  let data: KeyData;
  try {
    const parsed = JSON.parse(body) as KeyResponse;
    if (!parsed.data) return fail('response carried no key data');
    data = parsed.data;
  } catch {
    return fail(`Unparseable response: ${body.slice(0, 120)}`);
  }

  const limits: UsageLimit[] = [];
  const month = num(data.usage_monthly);
  if (Number.isFinite(month)) {
    limits.push({
      label: 'Month Spend',
      kind: 'balance',
      percent: 0,
      used: month,
      unit: '$',
      resetAt: nextUtcMonthStart(), // the UTC month counter rolls over
    });
  }

  const cap = num(data.limit);
  const remaining = num(data.limit_remaining);
  if (Number.isFinite(cap) && cap > 0) {
    const spent = Math.max(0, cap - (Number.isFinite(remaining) ? remaining : cap));
    const { kind, resetAt } = capWindow(data.limit_reset);
    limits.push({
      label: 'Key Limit',
      kind,
      percent: Math.max(0, Math.round((spent / cap) * 1000) / 10),
      used: spent,
      total: cap,
      unit: '$',
      ...(resetAt ? { resetAt } : {}),
    });
  }

  if (limits.length === 0) {
    return fail('key reported neither monthly usage nor a spending cap');
  }
  return { ok: true, provider, label, summary: { limits } };
}
