// Client-side mirror of the API response. Kept minimal and structurally typed
// so the dashboard can render without importing server types.

export type ProviderKey = 'claude' | 'codex' | 'glm' | 'supergrok' | 'minimax' | 'kimi';

export interface UsageLimit {
  label: string;
  kind: string;
  percent: number;
  used?: number;
  total?: number;
  resetAt?: string;
  estimated?: boolean;
  detail?: string;
}

export interface AccountUsage {
  key: string;
  ok: boolean;
  planLabel?: string;
  limits: UsageLimit[];
  error?: string;
}

export interface ProviderSummary {
  planLabel?: string;
  limits: UsageLimit[];
  accounts?: AccountUsage[];
  partial?: boolean;
  [key: string]: unknown;
}

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

export interface ProviderResponse {
  ok: boolean;
  timestamp: string;
  provider: ProviderResult;
}
