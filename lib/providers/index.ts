import { fetchClaudeUsage, isConfigured as claudeConfigured } from './claude';
import { fetchGeminiUsage, isConfigured as geminiConfigured } from './gemini';
import { fetchCodexUsage, isConfigured as codexConfigured } from './codex';
import { fetchCursorUsage, isConfigured as cursorConfigured } from './cursor';
import { fetchDevinUsage, isConfigured as devinConfigured } from './devin';
import { fetchGlmUsage, isConfigured as glmConfigured } from './glm';
import { fetchSupergrokUsage, isConfigured as supergrokConfigured } from './supergrok';
import { fetchMinimaxUsage, isConfigured as minimaxConfigured } from './minimax';
import { fetchKimiUsage, isConfigured as kimiConfigured } from './kimi';
import { fetchVolcengineUsage, isConfigured as volcengineConfigured } from './volcengine';
import { fetchStepfunUsage, isConfigured as stepfunConfigured } from './stepfun';
import { fetchDeepseekUsage, isConfigured as deepseekConfigured } from './deepseek';
import { fetchMimoUsage, isConfigured as mimoConfigured } from './mimo';
import { fetchOpenrouterUsage, isConfigured as openrouterConfigured } from './openrouter';
import { fetchQwenUsage, isConfigured as qwenConfigured } from './qwen';
import { magpieConfigured, magpieCoverage, magpieHint, magpieProviderResult } from './magpie';
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
  gemini: {
    key: 'gemini',
    fn: fetchGeminiUsage,
    isConfigured: geminiConfigured,
    configHint: 'log in via `agy`, or point GEMINI_CREDENTIALS_PATH at antigravity-oauth-token',
  },
  codex: {
    key: 'codex',
    fn: fetchCodexUsage,
    isConfigured: codexConfigured,
    configHint: 'run `codex login`, or point CODEX_AUTH_PATH at auth.json',
  },
  cursor: {
    key: 'cursor',
    fn: fetchCursorUsage,
    isConfigured: cursorConfigured,
    configHint:
      'log in via `cursor-agent login` (macOS keychain), or set CURSOR_ACCESS_TOKEN',
  },
  devin: {
    key: 'devin',
    fn: fetchDevinUsage,
    isConfigured: devinConfigured,
    configHint:
      'run `devin auth login`, point DEVIN_CREDENTIALS_PATH at credentials.toml, or set DEVIN_API_KEY',
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
  stepfun: {
    key: 'stepfun',
    fn: fetchStepfunUsage,
    isConfigured: stepfunConfigured,
    configHint:
      'set STEPFUN_COOKIE (Cookie header from a logged-in platform.stepfun.com) or STEPFUN_TOKEN (Oasis-Token)',
  },
  deepseek: {
    key: 'deepseek',
    fn: fetchDeepseekUsage,
    isConfigured: deepseekConfigured,
    configHint:
      'set DEEPSEEK_API_KEY (balance) and optionally DEEPSEEK_TOKEN (web-console userToken, month spend)',
  },
  mimo: {
    key: 'mimo',
    fn: fetchMimoUsage,
    isConfigured: mimoConfigured,
    configHint:
      'set MIMO_COOKIE (Cookie header from a logged-in platform.xiaomimimo.com console)',
  },
  openrouter: {
    key: 'openrouter',
    fn: fetchOpenrouterUsage,
    isConfigured: openrouterConfigured,
    configHint:
      'set OPENROUTER_MANAGEMENT_KEY (/settings/management-keys — wallet + month spend); OPENROUTER_API_KEY only as a per-key fallback',
  },
  qwen: {
    key: 'qwen',
    fn: fetchQwenUsage,
    isConfigured: qwenConfigured,
    configHint:
      'set QWEN_COOKIE (Cookie header from a logged-in platform.qianwenai.com request)',
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

/**
 * configuredMap plus the providers magpie can serve. magpie keeps the real
 * accounts, so a card whose provider has no local key still belongs on the
 * board when magpie carries it. Reads magpie's quota list (cached, one call
 * for the whole map); an unreachable magpie just leaves the local split.
 */
export async function configuredMapWithMagpie(): Promise<Record<ProviderKey, boolean>> {
  const out = configuredMap();
  if (!magpieConfigured()) return out;
  const coverage = await magpieCoverage();
  for (const key of PROVIDER_KEYS) {
    if (coverage[key]) out[key] = true;
  }
  return out;
}

/** Fetch a single provider's usage. Never throws — returns ok:false on failure. */
export async function fetchOneUsage(key: ProviderKey): Promise<ProviderResult> {
  const def = getProvider(key);
  const localConfigured = def.isConfigured();

  // magpie is the source of truth for the accounts it carries: one place holds
  // the sign-ins, and asking the vendor here as well would double the calls
  // and put the same account in two cards. MAGPIE_PREFER=0 keeps magpie as a
  // fallback only, for a machine whose own credentials should win.
  const preferMagpie = process.env.MAGPIE_PREFER !== '0' || !localConfigured;
  const bridged = preferMagpie ? await magpieProviderResult(def.key) : undefined;
  if (bridged) return bridged;

  // A provider with no key at all can only ever produce an error card, so say
  // so without touching the network. Distinct from a configured-but-broken
  // provider, which keeps its red offline card.
  if (!localConfigured) {
    return {
      ok: false,
      provider: def.key,
      label: def.key,
      notConfigured: true,
      error: def.configHint + ' — ' + magpieHint(),
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
