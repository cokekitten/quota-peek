// Client-side mirror of the API response. Kept minimal and structurally typed
// so the dashboard can render without importing server types.

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
  label: string;
  kind: string;
  percent: number;
  used?: number;
  total?: number;
  /** Display unit for the absolute used/total numbers, e.g. '¥' or 'cr'. */
  unit?: string;
  resetAt?: string;
  estimated?: boolean;
  expectedPercent?: number;
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
  /** True when the provider has no key / credential file at all (hidden by default). */
  notConfigured?: boolean;
  /** True when this is cached data served because the live fetch failed. */
  stale?: boolean;
}

/** Per-provider "has credentials" split, from GET /api/config. */
export type ConfiguredMap = Record<ProviderKey, boolean>;

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini',
  codex: 'Codex',
  glm: 'GLM',
  supergrok: 'SuperGrok',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  volcengine: 'Volcengine',
  stepfun: 'StepFun',
  deepseek: 'DeepSeek',
  mimo: 'MiMo',
  openrouter: 'OpenRouter',
};

/** Dashboard / history-page card order. */
export const PROVIDER_ORDER: ProviderKey[] = [
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

export interface ProviderResponse {
  ok: boolean;
  timestamp: string;
  provider: ProviderResult;
}
