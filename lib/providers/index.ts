import { fetchClaudeUsage, isConfigured as claudeConfigured } from './claude';
import { fetchCodexUsage, isConfigured as codexConfigured } from './codex';
import { fetchGlmUsage, isConfigured as glmConfigured } from './glm';
import { fetchSupergrokUsage, isConfigured as supergrokConfigured } from './supergrok';
import { fetchMinimaxUsage, isConfigured as minimaxConfigured } from './minimax';
import { fetchKimiUsage, isConfigured as kimiConfigured } from './kimi';
import { fetchVolcengineUsage, isConfigured as volcengineConfigured } from './volcengine';
import { PROVIDER_KEYS } from './types';
import type { ProviderDef, ProviderKey, ProviderResult } from './types';

export { PROVIDER_KEYS } from './types';
export type {
  ProviderKey,
  ProviderResult,
  ProviderSummary,
  UsageLimit,
  ProviderResponse,
} from './types';

export const PROVIDERS: Record<ProviderKey, ProviderDef> = {
  claude: {
    key: 'claude',
    fn: fetchClaudeUsage,
    isConfigured: claudeConfigured,
    configHint: 'run `claude login`, or point CLAUDE_CREDENTIALS_PATH at .credentials.json',
  },
  codex: {
    key: 'codex',
    fn: fetchCodexUsage,
    isConfigured: codexConfigured,
    configHint: 'run `codex login`, or point CODEX_AUTH_PATH at auth.json',
  },
  glm: {
    key: 'glm',
    fn: fetchGlmUsage,
    isConfigured: glmConfigured,
    configHint: 'set GLM_API_KEY (copy .env.example -> .env)',
  },
  supergrok: {
    key: 'supergrok',
    fn: fetchSupergrokUsage,
    isConfigured: supergrokConfigured,
    configHint: 'run `grok login`, or point GROK_AUTH_PATH at ~/.grok/auth.json',
  },
  minimax: {
    key: 'minimax',
    fn: fetchMinimaxUsage,
    isConfigured: minimaxConfigured,
    configHint: 'set MINIMAX_API_KEY (use your Token Plan Subscription Key)',
  },
  kimi: {
    key: 'kimi',
    fn: fetchKimiUsage,
    isConfigured: kimiConfigured,
    configHint: 'set KIMI_API_KEY, or log in via the Kimi Code CLI / KIMI_CREDENTIALS_PATH',
  },
  volcengine: {
    key: 'volcengine',
    fn: fetchVolcengineUsage,
    isConfigured: volcengineConfigured,
    configHint: 'set VOLC_ACCESS_KEY / VOLC_SECRET_KEY (火山引擎控制台 → 密钥管理)',
  },
};

/** Look up a provider by key. Throws on unknown keys. */
export function getProvider(key: string): ProviderDef {
  const def = PROVIDERS[key as ProviderKey];
  if (!def) {
    throw new Error(`Unknown provider: ${key}. Valid: ${PROVIDER_KEYS.join(', ')}`);
  }
  return def;
}

/**
 * Which providers have credentials to work with (local env/file check only).
 * Computed fresh on every call: env vars and credential files can appear or
 * disappear between refreshes without restarting the app.
 */
export function configuredMap(): Record<ProviderKey, boolean> {
  const out = {} as Record<ProviderKey, boolean>;
  for (const key of PROVIDER_KEYS) out[key] = PROVIDERS[key].isConfigured();
  return out;
}

/** Fetch a single provider's usage. Never throws — returns ok:false on failure. */
export async function fetchOneUsage(key: ProviderKey): Promise<ProviderResult> {
  const def = getProvider(key);
  // A provider with no key at all can only ever produce an error card, so say
  // so without touching the network. Distinct from a configured-but-broken
  // provider, which keeps its red offline card.
  if (!def.isConfigured()) {
    return {
      ok: false,
      provider: def.key,
      label: def.key,
      notConfigured: true,
      error: def.configHint,
    };
  }
  try {
    return await def.fn();
  } catch (err) {
    return {
      ok: false,
      provider: def.key,
      label: def.key,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
