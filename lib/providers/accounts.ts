import type { AccountUsage, ProviderKey, ProviderResult, UsageLimit } from './types';

/**
 * Generic multi-account support for key-based providers.
 *
 * Convention: the provider's existing env vars are account 1 (e.g. GLM_API_KEY).
 * Extra accounts use a numeric suffix: GLM_API_KEY_2, GLM_API_KEY_3, …
 * Numbering gaps are allowed (_2 unset, _3 set still works) and scanning is
 * capped. When 2+ accounts are configured, fetchMultiAccount merges their
 * windows into one card and attaches per-account detail as summary.accounts —
 * the dashboard renders a Σ/1/2 toggle purely from that field.
 */

/** Env values collected for one account, keyed by the UNSUFFIXED var name. */
export type AccountEnv = Record<string, string | undefined>;

export interface IndexedAccount {
  /** '1' for the unsuffixed account, otherwise the suffix ('2', '3', …). */
  key: string;
  env: AccountEnv;
}

export interface ReadIndexedOptions {
  /** Env var base names that together form one account's config. */
  vars: string[];
  /**
   * Vars whose presence marks account N (N ≥ 2) as configured. Defaults to
   * `vars`. Use a subset (e.g. only the API key) when secondary vars like a
   * base URL shouldn't create an account on their own.
   */
  triggerVars?: string[];
  /** Highest suffix to scan. Gaps are skipped, scanning never stops early. */
  maxIndex?: number;
}

export function readIndexedAccounts({
  vars,
  triggerVars,
  maxIndex = 8,
}: ReadIndexedOptions): IndexedAccount[] {
  const accounts: IndexedAccount[] = [
    { key: '1', env: Object.fromEntries(vars.map((v) => [v, process.env[v]])) },
  ];
  for (let n = 2; n <= maxIndex; n++) {
    const env: AccountEnv = Object.fromEntries(vars.map((v) => [v, process.env[`${v}_${n}`]]));
    if ((triggerVars ?? vars).some((v) => env[v])) {
      accounts.push({ key: String(n), env });
    }
  }
  return accounts;
}

/** Convenience: the env var name for account `key` ('GLM_API_KEY' vs 'GLM_API_KEY_2'). */
export function accountEnvName(base: string, key: string): string {
  return key === '1' ? base : `${base}_${key}`;
}

export interface FetchMultiMeta {
  provider: ProviderKey;
  label: string;
}

/**
 * Fan out to all configured accounts in parallel and combine the results.
 * A single configured account returns the provider's result untouched (no
 * toggle on the card). With 2+, the merged view carries combined limits plus
 * summary.accounts for the per-account toggle. Never includes credentials —
 * account views carry only key/ok/planLabel/limits/error.
 */
export async function fetchMultiAccount<T>(
  accounts: ReadonlyArray<{ key: string; config: T }>,
  fetchAccount: (config: T) => Promise<ProviderResult>,
  meta: FetchMultiMeta,
): Promise<ProviderResult> {
  const results = await Promise.all(accounts.map((a) => fetchAccount(a.config)));
  if (results.length === 1) return results[0];

  const accountViews: AccountUsage[] = results.map((r, i) => ({
    key: accounts[i].key,
    ok: r.ok,
    planLabel: r.summary?.planLabel,
    limits: r.summary?.limits ?? [],
    error: r.error,
  }));

  const okIdx = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
  if (okIdx.length === 0) {
    return {
      ok: false,
      provider: meta.provider,
      label: meta.label,
      error: results.map((r, i) => `Account ${accounts[i].key}: ${r.error || 'unknown'}`).join(' · '),
    };
  }

  // Merge only the accounts that responded; failed ones still appear in the
  // toggle (with their error) but don't skew the combined bars.
  const plans = [
    ...new Set(
      okIdx.map((i) => results[i].summary?.planLabel).filter((p): p is string => !!p),
    ),
  ];
  return {
    ok: true,
    provider: meta.provider,
    label: meta.label,
    summary: {
      planLabel: plans.join(' + ') || undefined,
      limits: mergeLimits(okIdx.flatMap((i) => results[i].summary?.limits ?? [])),
      accounts: accountViews,
      partial: okIdx.length < results.length || undefined,
    },
  };
}

/**
 * Combine per-account windows grouped by `kind`:
 * - every account reports used/total → exact weighted merge (Σused / Σtotal);
 * - otherwise → mean of percents, flagged `estimated` (never passed off as
 *   exact; the UI marks it with ≈).
 * resetAt is the earliest upcoming reset across accounts — when combined
 * capacity first starts recovering. Merged rows also carry `expectedPercent`:
 * the quota-weighted mean of each account's expected consumption by elapsed
 * time (windows share a duration but reset independently), so the UI can show
 * a pace delta for merged bars too.
 */
export function mergeLimits(limits: UsageLimit[]): UsageLimit[] {
  const byKind = new Map<string, UsageLimit[]>();
  for (const l of limits) {
    const group = byKind.get(l.kind);
    if (group) group.push(l);
    else byKind.set(l.kind, [l]);
  }

  const out: UsageLimit[] = [];
  for (const group of byKind.values()) {
    const merged: UsageLimit = { label: group[0].label, kind: group[0].kind, percent: 0 };
    const exact = group.every(
      (l) => typeof l.used === 'number' && typeof l.total === 'number' && (l.total ?? 0) > 0,
    );
    if (exact) {
      const used = group.reduce((s, l) => s + (l.used ?? 0), 0);
      const total = group.reduce((s, l) => s + (l.total ?? 0), 0);
      merged.percent = clampPercent(Math.round((used / total) * 100));
      merged.used = used;
      merged.total = total;
    } else {
      merged.percent = clampPercent(
        Math.round(group.reduce((s, l) => s + l.percent, 0) / group.length),
      );
      merged.estimated = true;
    }
    const resets = group
      .map((l) => l.resetAt)
      .filter((r): r is string => !!r)
      .sort();
    if (resets[0]) merged.resetAt = resets[0];
    // Pace for merged rows: each account's window shares the same duration but
    // resets at its own time, so weight the per-account expected consumption
    // (by elapsed time) with its quota. Only when every account reports a
    // reset — comparing against a partial time base would be misleading.
    const duration = KIND_DURATION_MS[merged.kind];
    if (duration && group.every((l) => !!l.resetAt)) {
      const now = Date.now();
      let wSum = 0;
      let eSum = 0;
      for (const l of group) {
        const w = exact ? (l.total ?? 1) : 1;
        const remainMs = new Date(l.resetAt!).getTime() - now;
        const expected = Math.min(100, Math.max(0, (1 - remainMs / duration) * 100));
        wSum += w;
        eSum += w * expected;
      }
      if (wSum > 0) merged.expectedPercent = eSum / wSum;
    }
    out.push(merged);
  }
  return out;
}

/** Window durations implied by kind, mirroring the card's pace math. */
const KIND_DURATION_MS: Record<string, number> = {
  '5h': 5 * 3600e3,
  weekly: 7 * 24 * 3600e3,
};

function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, v));
}
