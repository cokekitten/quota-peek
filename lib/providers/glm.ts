import type { ProviderResult, UsageLimit } from './types';

const BASE_URL = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn').replace(/\/$/, '');
const QUOTA_PATH = '/api/monitor/usage/quota/limit';

const LEVEL_LABEL: Record<string, string> = { lite: 'Lite', pro: 'Pro', max: 'Max' };

interface GlmUsageDetail {
  modelCode?: string;
  usage?: number;
}
interface GlmLimit {
  type?: string;
  usage?: number;
  currentValue?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: GlmUsageDetail[];
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
      label: 'GLM Coding Plan',
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
        label: 'GLM Coding Plan',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const data = (await resp.json()) as GlmResponse;
    if (!data?.success && data?.code !== 200) {
      return {
        ok: false,
        provider: 'glm',
        label: 'GLM Coding Plan',
        error: data?.msg || 'unknown error',
        raw: data as unknown,
      };
    }
    return {
      ok: true,
      provider: 'glm',
      label: 'GLM Coding Plan',
      summary: summarize(data.data),
      raw: data as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'glm',
      label: 'GLM Coding Plan',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Turn GLM's limits[] into a normalized, dashboard-friendly shape. */
function summarize(d?: GlmData): { level: string | null; planLabel: string; limits: UsageLimit[] } {
  const level = d?.level ? LEVEL_LABEL[d.level] || d.level : null;
  const now = Date.now();
  const limits = (d?.limits || []).map((l) => normalizeLimit(l, now));
  return {
    level: level ?? null,
    planLabel: level ? `GLM ${level}` : 'GLM',
    limits,
  };
}

function normalizeLimit(l: GlmLimit, now: number): UsageLimit {
  const hasMcp = Array.isArray(l.usageDetails) && l.usageDetails.length > 0;
  const period = l.nextResetTime ? periodLabel(l.nextResetTime - now) : null;

  let kind: string;
  if (hasMcp) kind = 'MCP';
  else if (l.type === 'TIME_LIMIT') kind = 'Prompts';
  else if (l.type === 'TOKENS_LIMIT') kind = 'Tokens';
  else kind = l.type || 'Limit';

  const out: UsageLimit = {
    label: period ? `${kind} · ${period}` : kind,
    kind,
    percent: typeof l.percentage === 'number' ? l.percentage : 0,
  };
  if (typeof l.currentValue === 'number' && typeof l.usage === 'number') {
    out.used = l.currentValue;
    out.total = l.usage;
  }
  if (l.nextResetTime) out.resetAt = new Date(l.nextResetTime).toISOString();
  if (hasMcp) {
    const detail = (l.usageDetails || [])
      .filter((u) => (u.usage ?? 0) > 0)
      .map((u) => `${u.modelCode}: ${u.usage}`)
      .join(', ');
    if (detail) out.detail = detail;
  }
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
