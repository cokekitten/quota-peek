import type { ProviderResult, UsageLimit } from './types';

const BASE_URL = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn').replace(/\/$/, '');
const QUOTA_PATH = '/api/monitor/usage/quota/limit';

const LEVEL_LABEL: Record<string, string> = { lite: 'Lite', pro: 'Pro', max: 'Max' };

interface GlmLimit {
  type?: string;
  unit?: number; // window-type code: 3 = 5h window, 6 = weekly
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

/** Keep only the 5h + weekly token windows; classify by the `unit` code.
 *  GLM's `unit` field is the authoritative window type (3 = 5h, 6 = weekly).
 *  We deliberately do NOT infer the window from nextResetTime — a weekly window
 *  can reset in under an hour when it's near its end, so reset time does not
 *  tell you the window length. */
function summarize(d?: GlmData): { level: string | null; planLabel: string; limits: UsageLimit[] } {
  const level = d?.level ? LEVEL_LABEL[d.level] || d.level : null;
  const limits = (d?.limits || [])
    .filter((l) => l.type === 'TOKENS_LIMIT')
    .map(normalizeLimit)
    .filter((l): l is UsageLimit => l !== null);
  return {
    level: level ?? null,
    planLabel: level ? `GLM ${level}` : 'GLM',
    limits,
  };
}

function normalizeLimit(l: GlmLimit): UsageLimit | null {
  const kind = classifyUnit(l.unit);
  if (!kind) return null;
  const out: UsageLimit = {
    label: kind === '5h' ? '5h Window' : 'Weekly',
    kind,
    percent: typeof l.percentage === 'number' ? l.percentage : 0,
  };
  if (typeof l.nextResetTime === 'number') {
    out.resetAt = new Date(l.nextResetTime).toISOString();
  }
  return out;
}

/** Map GLM's `unit` code to our window kind. */
function classifyUnit(unit?: number): '5h' | 'weekly' | null {
  if (unit === 3) return '5h';
  if (unit === 6) return 'weekly';
  return null;
}
