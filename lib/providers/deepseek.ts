import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * DeepSeek usage — a pay-as-you-go money card, not windowed quotas.
 *
 * Two endpoints, two credentials:
 *
 *   GET api.deepseek.com/user/balance                  (Bearer sk-… API key)
 *     → { is_available, balance_infos: [{ currency, total_balance,
 *        granted_balance, topped_up_balance }] }        — official, documented
 *
 *   GET platform.deepseek.com/api/v0/usage/by_api_key/cost?start&end&tz
 *     (Bearer web-console userToken + browser headers)  — internal, what the
 *       platform's own 用量 page calls; returns time-bucketed spend. The
 *       sk- key is rejected here (40003), and the userToken is the `value`
 *       inside localStorage.userToken on platform.deepseek.com.
 *
 * With both, the card shows "Month Spend" (calendar month, CNY) and "Balance";
 * with only the API key it degrades to the Balance row. The spend bar is the
 * fraction of the current money pool already burned this month —
 * spend/(spend+balance) — so it rises as you spend and drops when you top up.
 * A failing/absent token never fails the card; the balance row carries a note.
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const PLATFORM_USAGE_URL =
  'https://platform.deepseek.com/api/v0/usage/by_api_key/cost';
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 15000);
// platform.deepseek.com sits behind a WAF that 403s non-browser requests.
const PLATFORM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: 'https://platform.deepseek.com',
  Referer: 'https://platform.deepseek.com/usage',
};

// Env vars forming one account's config; the API key or token marks it.
const ENV_VARS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_TOKEN', 'DEEPSEEK_BASE_URL'];
const TRIGGER_VARS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_TOKEN'];

interface BalanceInfo {
  currency?: string;
  total_balance?: string | number;
  granted_balance?: string | number;
  topped_up_balance?: string | number;
}

interface BalanceResponse {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

/** cost response: data.biz_data.data[].series[].buckets[].cost (money) */
interface CostResponse {
  code?: number;
  data?: {
    biz_data?: {
      data?: Array<{
        currency?: string;
        series?: Array<{ buckets?: Array<{ time?: string | number; cost?: number }> }>;
      }>;
    };
  };
}

/** Env values that mark an account as configured. */
export function isConfigured(): boolean {
  return readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some(
    (a) => Boolean(a.env.DEEPSEEK_API_KEY || a.env.DEEPSEEK_TOKEN),
  );
}

export function fetchDeepseekUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).map(
    ({ key, env }) => ({
      key,
      config: {
        apiKey: env.DEEPSEEK_API_KEY,
        token: env.DEEPSEEK_TOKEN,
        apiKeyEnv: accountEnvName('DEEPSEEK_API_KEY', key),
        baseUrl: (env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(
          /\/$/,
          '',
        ),
      },
    }),
  );
  return fetchMultiAccount(accounts, fetchDeepseekAccount, {
    provider: 'deepseek',
    label: 'DeepSeek',
  });
}

interface DeepseekAccount {
  apiKey?: string;
  token?: string;
  apiKeyEnv: string;
  baseUrl: string;
}

const num = (v: string | number | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** One decimal — money moves in small fractions of the pool. */
const percentPool = (spend: number, balance: number): number => {
  const pool = spend + balance;
  if (!(pool > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((spend / pool) * 1000) / 10));
};

async function fetchDeepseekAccount(account: DeepseekAccount): Promise<ProviderResult> {
  const provider = 'deepseek' as const;
  const label = 'DeepSeek';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  // ---- balance (official API, sk- key) -------------------------------------
  let balance = NaN;
  let currency = '';
  let granted = NaN;
  let toppedUp = NaN;
  let isAvailable: boolean | undefined;
  if (account.apiKey) {
    try {
      const resp = await fetch(`${account.baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${account.apiKey}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        return fail(`Balance HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`.trim());
      }
      const data = (await resp.json()) as BalanceResponse;
      // Multiple currencies are possible in theory; lead with the largest pool.
      const infos = (data.balance_infos ?? [])
        .map((b) => ({ b, total: num(b.total_balance) }))
        .filter((x) => Number.isFinite(x.total))
        .sort((x, y) => y.total - x.total);
      if (infos.length === 0) return fail('Balance response carried no balance_infos');
      balance = infos[0].total;
      currency = infos[0].b.currency || '';
      granted = num(infos[0].b.granted_balance);
      toppedUp = num(infos[0].b.topped_up_balance);
      isAvailable = data.is_available;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- month spend (internal platform API, web userToken) ------------------
  let spend = NaN;
  let spendError: string | undefined;
  if (account.token) {
    try {
      spend = await fetchMonthSpend(account.token);
    } catch (err) {
      spendError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- assemble rows --------------------------------------------------------
  const limits: UsageLimit[] = [];
  const unit = currency === 'USD' ? '$' : '¥';
  const haveSpend = Number.isFinite(spend) && spend >= 0;
  const haveBalance = Number.isFinite(balance);

  if (haveSpend) {
    const pool = spend + (haveBalance ? balance : 0);
    limits.push({
      label: 'Month Spend',
      kind: 'spend',
      percent: percentPool(spend, haveBalance ? balance : 0),
      used: spend,
      total: pool > 0 ? pool : undefined,
      unit,
      detail: haveBalance ? undefined : spendError,
      // Money doesn't reset; no resetAt, and 'spend' has no window duration in
      // the card's pace table, so no pace delta either.
    });
  }

  if (haveBalance) {
    const bits: string[] = [];
    if (Number.isFinite(granted) && granted > 0) bits.push(`granted ${unit}${fmtMoney(granted)}`);
    if (Number.isFinite(toppedUp) && toppedUp > 0) bits.push(`top-up ${unit}${fmtMoney(toppedUp)}`);
    if (isAvailable === false) bits.push('insufficient for API calls');
    if (!haveSpend && spendError) bits.push(`spend n/a — ${spendError}`);
    limits.push({
      label: 'Balance',
      kind: 'balance',
      percent: 0,
      used: balance,
      unit,
      detail: bits.join(' · ') || undefined,
    });
  }

  if (limits.length === 0) {
    return fail(`${account.apiKeyEnv} not set (or DEEPSEEK_TOKEN for spend) — nothing to show`);
  }
  return { ok: true, provider, label, summary: { limits } };
}

/** Calendar-month spend so far, in the account's billing currency (CNY). */
async function fetchMonthSpend(token: string): Promise<number> {
  const now = new Date();
  const tzSec = -now.getTimezoneOffset() * 60;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = Math.floor(monthStart.getTime() / 1000);
  const end = Math.floor(now.getTime() / 1000) + 60; // inclusive-ish, server buckets by day
  const url = `${PLATFORM_USAGE_URL}?start=${start}&end=${end}&tz=${tzSec}`;
  const resp = await fetch(url, {
    headers: { ...PLATFORM_HEADERS, Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403 || /40003|invalid token/i.test(text)) {
    throw new Error(
      'usage token rejected (needs the web-console userToken from platform.deepseek.com, not the sk- key)',
    );
  }
  if (!resp.ok) throw new Error(`usage HTTP ${resp.status} ${text.slice(0, 80)}`.trim());
  let data: CostResponse;
  try {
    data = JSON.parse(text) as CostResponse;
  } catch {
    throw new Error(`usage response unparseable: ${text.slice(0, 80)}`);
  }
  const rows = data.data?.biz_data?.data ?? [];
  let total = 0;
  let seen = false;
  for (const row of rows) {
    for (const s of row.series ?? []) {
      for (const b of s.buckets ?? []) {
        const cost = num(b.cost);
        if (Number.isFinite(cost)) {
          total += cost;
          seen = true;
        }
      }
    }
  }
  if (!seen) throw new Error('usage response carried no cost buckets');
  return total;
}

function fmtMoney(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : String(Math.round(n * 100) / 100);
}
