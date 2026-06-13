/** Shared domain types for quota-peek providers. */

export type ProviderKey = 'claude' | 'codex' | 'glm';

export interface UsageLimit {
  /** Human label for the metric, e.g. "Primary · 5h window". */
  label: string;
  /** Machine kind, e.g. "current_session" / "Primary" / "MCP". */
  kind: string;
  /** 0–100 usage percentage. */
  percent: number;
  /** Absolute usage count, if the provider reports one (e.g. GLM MCP). */
  used?: number;
  /** Total quota, if reported. */
  total?: number;
  /** ISO timestamp when the window resets, if known. */
  resetAt?: string;
  /** Optional extra detail, e.g. per-model breakdown. */
  detail?: string;
}

export interface ProviderSummary {
  /** Display label for the plan, e.g. "GLM Max". */
  planLabel?: string;
  /** Normalized metric rows. */
  limits: UsageLimit[];
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
}

export const PROVIDER_KEYS: ProviderKey[] = ['claude', 'codex', 'glm'];
