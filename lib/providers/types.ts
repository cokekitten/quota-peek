/** Shared domain types for quota-peek providers. */

export type ProviderKey =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'glm'
  | 'supergrok'
  | 'minimax'
  | 'kimi'
  | 'volcengine'
  | 'stepfun'
  | 'deepseek'
  | 'mimo'
  | 'openrouter';

export interface UsageLimit {
  /** Human label for the metric, e.g. "Primary · 5h window". */
  label: string;
  /** Machine kind, e.g. "current_session" / "Primary" / "MCP". */
  kind: string;
  /** Usage percentage (money ratios like spend/top-up may exceed 100). */
  percent: number;
  /** Absolute usage count, if the provider reports one (e.g. GLM MCP). */
  used?: number;
  /** Total quota, if reported. */
  total?: number;
  /** ISO timestamp when the window resets, if known. */
  resetAt?: string;
  /** True when percent is a cross-account estimate (mixed/unknown plans). */
  estimated?: boolean;
  /**
   * Merge-internal provenance hint: verified capacity-class the row came
   * from (see ProviderSummary.planKey). Equal keys imply equal window
   * capacities, so mergeLimits can treat a mean of fractions as exact
   * instead of flagging it estimated.
   */
  planKey?: string;
  /**
   * Merged rows only: quota-weighted expected consumption % by elapsed time,
   * computed at fetch time from each account's own reset clock. Lets the UI
   * show a pace delta even though merged windows don't share one reset time.
   */
  expectedPercent?: number;
  /** Display unit for the absolute used/total numbers, e.g. '¥' or 'cr'. */
  unit?: string;
  /** Optional extra detail, e.g. per-model breakdown. */
  detail?: string;
}

/** Per-account view for multi-account providers (e.g. two Kimi memberships). */
export interface AccountUsage {
  /** Short display key, e.g. "1" / "2". */
  key: string;
  ok: boolean;
  planLabel?: string;
  limits: UsageLimit[];
  error?: string;
}

export interface ProviderSummary {
  /** Display label for the plan, e.g. "GLM Max". */
  planLabel?: string;
  /**
   * Verified capacity-class identifier (e.g. GLM's API `level`, a real
   * PlanType, or an explicit user-set label). Two accounts with the same
   * planKey have equal window quotas by definition, so cross-account
   * merges can be exact. Providers must NOT set this from a fabricated
   * display fallback — unknown stays undefined and merges stay estimated.
   */
  planKey?: string;
  /** Normalized metric rows. */
  limits: UsageLimit[];
  /** Per-account breakdown when more than one account is configured. */
  accounts?: AccountUsage[];
  /** True when some configured accounts failed and were excluded from the merge. */
  partial?: boolean;
  /** Provider may attach extra fields (plan_type, level, …) — kept for the UI. */
  [key: string]: unknown;
}

/** A single provider's fetch result. Failures carry `error` and omit summary. */
export interface ProviderResult {
  ok: boolean;
  provider: ProviderKey;
  label: string;
  summary?: ProviderSummary;
  text?: string;
  raw?: unknown;
  error?: string;
  /**
   * True when `error` means "no key / no credentials file at all" rather than
   * "configured but the call failed". The dashboard hides these cards by
   * default (header toggle shows them); real failures are never hidden.
   */
  notConfigured?: boolean;
  /** True when this is cached data served because the live fetch failed. */
  stale?: boolean;
}

/** Envelope returned by the API routes. */
export interface ProviderResponse {
  ok: boolean;
  timestamp: string;
  provider: ProviderResult;
}

export interface ProviderDef {
  key: ProviderKey;
  fn: () => Promise<ProviderResult>;
  /**
   * Cheap local check for "does this provider have anything to authenticate
   * with?" — env vars and/or a credentials file on disk. Never touches the
   * network. A provider that is configured but whose token expired or whose
   * API is down still reports configured:true, so its offline card stays
   * visible instead of being mistaken for an unconfigured one.
   */
  isConfigured: () => boolean;
  /** What to set to make the provider usable, e.g. "set GLM_API_KEY". */
  configHint: string;
}

export const PROVIDER_KEYS: ProviderKey[] = [
  'claude',
  'kimi',
  'codex',
  'gemini',
  'deepseek',
  'mimo',
  'glm',
  'stepfun',
  'supergrok',
  'minimax',
  'openrouter',
  'volcengine',
];
