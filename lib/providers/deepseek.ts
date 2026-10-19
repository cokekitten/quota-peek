import type { ProviderResult, UsageLimit } from './types';
import {
  accountEnvName,
  fetchMultiAccount,
  nextMonthStart,
  poolSharePercent,
  readIndexedAccounts,
  thisMonthStart,
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
 * With both, the card shows one 消费金额/余额 row: the current month's spend
 * (当月, the console's month filter) over the **complete** balance —
 * 充值余额 + 赠送金额, which is exactly the sum the API states as
 * `total_balance`. 赠金 is real spendable money, so leading with the top-up
 * half alone understates the pool; the row's note names both halves instead.
 * The row's percent is the spend share of the money pool,
 * spend / (spend + balance) — bounded 100% by construction. With only the API
 * key it degrades to a bare Balance row (the same complete balance). A
 * failing/absent token never fails the card; the money row carries a note.
 *
 * Two things about the window are worth knowing before touching this:
 *
 *  - The endpoint accepts any start/end (≤31 days; a wider range comes back
 *    empty), so the window is ours to choose. The console OPENS on 近 30 天
 *    (`preset:"last30Days"` in its bundle); this card asks for the calendar
 *    month — the only one that can carry a percent, because its denominator
 *    (spend + balance = 月初余额) is constant, so the bar grows linearly and
 *    stops at 100%. A rolling 30-day spend over a point-in-time balance is
 *    not a pool at all. Expect the two totals to differ by design.
 *  - Because the span is real, both ends are reported (`paceStartAt` +
 *    `resetAt`), so the pace badge measures 28–31 days, not a 30-day stand-in.
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
  let balance = NaN; // 完整余额 = 充值余额 + 赠送金额
  let topup = NaN; // 充值余额 — named in the note, not the headline
  let granted = NaN; // 赠金 — ditto
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
      // 充值余额 + 赠送金额 is the complete, spendable balance, and
      // `total_balance` states exactly that sum — lead with it, and only
      // rebuild it from the halves when the payload omits it. Multiple
      // currencies are possible in theory; lead with the largest pool.
      const infos = (data.balance_infos ?? [])
        .map((b) => {
          const topped = num(b.topped_up_balance);
          const grant = num(b.granted_balance);
          const total = num(b.total_balance);
          const halves = [topped, grant].filter((n) => Number.isFinite(n));
          return {
            b,
            complete: Number.isFinite(total)
              ? total
              : halves.length > 0
                ? halves.reduce((s, n) => s + n, 0)
                : NaN,
          };
        })
        .filter((x) => Number.isFinite(x.complete))
        .sort((x, y) => y.complete - x.complete);
      if (infos.length === 0) return fail('Balance response carried no balance_infos');
      const info = infos[0].b;
      balance = infos[0].complete;
      topup = num(info.topped_up_balance);
      granted = num(info.granted_balance);
      currency = info.currency || '';
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
  const haveBalance = Number.isFinite(balance);
  const notes: string[] = [];
  // The headline is a sum, so name the halves it was summed from.
  const composition = splitNote(topup, granted, unit);
  if (composition) notes.push(composition);
  if (isAvailable === false) notes.push('insufficient for API calls');
  if (!haveSpend && spendError) notes.push(`spend n/a — ${spendError}`);
  const detail = notes.join(' · ') || undefined;

  if (haveSpend) {
    limits.push({
      label: 'Spend / Pool',
      kind: 'spend',
      percent: haveBalance ? percentPool(spend, balance) : 0,
      used: spend,
      total: haveBalance ? balance : undefined,
      unit,
      detail,
      // Money itself never resets, but the month window does — the rollover
      // anchors both the "Resets in …" line and the over/under pace delta.
      resetAt: nextMonthStart(),
      // The window is the calendar month (当月消费), so the pace yardstick is
      // the real month length, not a 30-day stand-in.
      paceStartAt: thisMonthStart(),
    });
  } else if (haveBalance) {
    limits.push({
      label: 'Balance',
      kind: 'balance',
      percent: 0,
      used: balance,
      unit,
      detail,
    });
  }

  if (limits.length === 0) {
    return fail(`${account.apiKeyEnv} not set (or DEEPSEEK_TOKEN for spend) — nothing to show`);
  }
  return { ok: true, provider, label, summary: { limits } };
}

/**
 * `¥410.35 top-up + ¥1,038.26 granted` — the two halves the complete balance
 * is summed from. One half alone restates the row's own number, so it stays
 * silent (a zero 赠金 is not worth a word either).
 */
function splitNote(topup: number, granted: number, unit: string): string | undefined {
  const money = (n: number) =>
    `${unit}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const halves: string[] = [];
  if (Number.isFinite(topup)) halves.push(`${money(topup)} top-up`);
  if (Number.isFinite(granted) && granted > 0) halves.push(`${money(granted)} granted`);
  return halves.length === 2 ? halves.join(' + ') : undefined;
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
