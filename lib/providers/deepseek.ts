import type { ProviderResult, UsageLimit } from './types';
import {
  accountEnvName,
  fetchMultiAccount,
  nextMonthStart,
  poolSharePercent,
  readIndexedAccounts,
} from './accounts';

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
 * With both, the card shows one 消费金额/充值余额 row: the current month's
 * spend (当月, the console's month filter) over the top-up balance
 * (充值余额 — what the console headlines; granted/赠金 is not re-stated).
 * The row's percent is the spend share of the money pool,
 * spend / (spend + top-up) — bounded 100% by construction. With only the API
 * key it degrades to a bare Balance row (充值余额). A failing/absent token
 * never fails the card; the money row carries a note.
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

/** Spend share of the money pool (spend + top-up) — shared with the other
 * money cards, bounded 100% by construction. */
const percentPool = (spend: number, topup: number): number => poolSharePercent(spend, topup);

async function fetchDeepseekAccount(account: DeepseekAccount): Promise<ProviderResult> {
  const provider = 'deepseek' as const;
  const label = 'DeepSeek';
  const fail = (error: string): ProviderResult => ({ ok: false, provider, label, error });

  // ---- balance (official API, sk- key) -------------------------------------
  let topup = NaN;
  let currency = '';
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
      // 充值余额 first — the platform's headline number; payloads that don't
      // split granted vs topped up fall back to the total.
      topup = num(infos[0].b.topped_up_balance);
      if (!Number.isFinite(topup)) topup = infos[0].total;
      currency = infos[0].b.currency || '';
      isAvailable = data.is_available;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- month spend (internal platform API, web userToken) -----------------
  let spend = NaN;
  let spendError: string | undefined;
  if (account.token) {
    try {
      spend = await fetchMonthSpend(account.token);
    } catch (err) {
      spendError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- assemble the row(s) ------------------------------------------------
  const limits: UsageLimit[] = [];
  const unit = currency === 'USD' ? '$' : '¥';
  const haveSpend = Number.isFinite(spend) && spend >= 0;
  const haveTopup = Number.isFinite(topup);
  const notes: string[] = [];
  if (isAvailable === false) notes.push('insufficient for API calls');
  if (!haveSpend && spendError) notes.push(`spend n/a — ${spendError}`);
  const detail = notes.join(' · ') || undefined;

  if (haveSpend) {
    limits.push({
      label: 'Spend / Top-up',
      kind: 'spend',
      percent: haveTopup ? percentPool(spend, topup) : 0,
      used: spend,
      total: haveTopup ? topup : undefined,
      unit,
      detail,
      // Money itself never resets, but the month window does — the rollover
      // anchors both the "Resets in …" line and the over/under pace delta.
      resetAt: nextMonthStart(),
    });
  } else if (haveTopup) {
    limits.push({
      label: 'Balance',
      kind: 'balance',
      percent: 0,
      used: topup,
      unit,
      detail,
    });
  }

  if (limits.length === 0) {
    return fail(`${account.apiKeyEnv} not set (or DEEPSEEK_TOKEN for spend) — nothing to show`);
  }
  return { ok: true, provider, label, summary: { limits } };
}

/** Current-month spend (当月) in the account's billing currency (CNY). */
async function fetchMonthSpend(token: string): Promise<number> {
  const now = new Date();
  const tzSec = -now.getTimezoneOffset() * 60;
  // Both bounds must be aligned to local midnights — the platform answers
  // INVALID_PARAM for anything else (and the buckets are daily: 86400).
  const midnight = (dt: Date) =>
    Math.floor(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime() / 1000);
  // 当月: the 1st's local midnight through the end of today.
  const start = midnight(new Date(now.getFullYear(), now.getMonth(), 1));
  const end = midnight(now) + 86400; // include all of today's buckets
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
