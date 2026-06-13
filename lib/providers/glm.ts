import type { ProviderResult, UsageLimit } from './types';

const BASE_URL = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn').replace(/\/$/, '');
const QUOTA_PATH = '/api/monitor/usage/quota/limit';

const LEVEL_LABEL: Record<string, string> = { lite: 'Lite', pro: 'Pro', max: 'Max' };

interface GlmLimit {
  type?: string;
  percentage?: number;
  nextResetTime?: number;
}
interface GlmData {
  level?: string;
  limits?: GlmLimit[];
}
interface GlmResponse {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: GlmData;
}

/**
 * GLM Coding Plan usage via the public monitor endpoint.
 * Requires GLM_API_KEY (sent as the raw Authorization header).
 */
export async function fetchGlmUsage(): Promise<ProviderResult> {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      provider: 'glm',
      label: 'GLM',
      error: 'GLM_API_KEY not set (copy .env.example -> .env)',
    };
  }

  try {
    const resp = await fetch(`${BASE_URL}${QUOTA_PATH}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
    });
    if (!resp.ok) {
      return {
        ok: false,
        provider: 'glm',
        label: 'GLM',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const data = (await resp.json()) as GlmResponse;
    if (!data?.success && data?.code !== 200) {
      return {
        ok: false,
        provider: 'glm',
        label: 'GLM',
        error: data?.msg || 'unknown error',
        raw: data as unknown,
      };
    }
    return {
      ok: true,
      provider: 'glm',
      label: 'GLM',
      summary: summarize(data.data),
      raw: data as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'glm',
      label: 'GLM',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Keep only the 5h + weekly token windows; standardize their labels. */
function summarize(d?: GlmData): { level: string | null; planLabel: string; limits: UsageLimit[] } {
  const level = d?.level ? LEVEL_LABEL[d.level] || d.level : null;
  const now = Date.now();
  const limits = (d?.limits || [])
    .filter((l): l is GlmLimit & { nextResetTime: number; type: string } =>
      l.type === 'TOKENS_LIMIT' && typeof l.nextResetTime === 'number',
    )
    .map((l) => normalizeLimit(l, now))
    .filter((l): l is UsageLimit => l !== null);
  return {
    level: level ?? null,
    planLabel: level ? `GLM ${level}` : 'GLM',
    limits,
  };
}

function normalizeLimit(l: GlmLimit & { nextResetTime: number }, now: number): UsageLimit | null {
  const period = periodLabel(l.nextResetTime - now);
  if (period !== '5h window' && period !== 'weekly') return null;
  const out: UsageLimit = {
    label: period === '5h window' ? '5h Window' : 'Weekly',
    kind: period === '5h window' ? '5h' : 'weekly',
    percent: typeof l.percentage === 'number' ? l.percentage : 0,
  };
  out.resetAt = new Date(l.nextResetTime).toISOString();
  return out;
}

/** Derive a human period label from a reset delta (ms). */
function periodLabel(deltaMs: number): string {
  const h = deltaMs / 3_600_000;
  if (h <= 12) return '5h window';
  if (h <= 8 * 24) return 'weekly';
  if (h <= 35 * 24) return 'monthly';
  return `~${Math.round(h / 24)}d`;
}
