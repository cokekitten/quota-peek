import { fetchClaudeUsage } from './claude';
import { fetchCodexUsage } from './codex';
import { fetchGlmUsage } from './glm';
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
  claude: { key: 'claude', fn: fetchClaudeUsage },
  codex: { key: 'codex', fn: fetchCodexUsage },
  glm: { key: 'glm', fn: fetchGlmUsage },
};

/** Look up a provider by key. Throws on unknown keys. */
export function getProvider(key: string): ProviderDef {
  const def = PROVIDERS[key as ProviderKey];
  if (!def) {
    throw new Error(`Unknown provider: ${key}. Valid: ${PROVIDER_KEYS.join(', ')}`);
  }
  return def;
}

/** Fetch a single provider's usage. Never throws — returns ok:false on failure. */
export async function fetchOneUsage(key: ProviderKey): Promise<ProviderResult> {
  const def = getProvider(key);
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
