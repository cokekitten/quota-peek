const BASE_URL = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn').replace(/\/$/, '');
const QUOTA_PATH = '/api/monitor/usage/quota/limit';

const LEVEL_LABEL = { lite: 'Lite', pro: 'Pro', max: 'Max' };

/**
 * GLM Coding Plan usage via the public monitor endpoint.
 * Requires GLM_API_KEY (sent as the raw Authorization header).
 */
export async function fetchGlmUsage() {
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
    const data = await resp.json();
    if (!data?.success && data?.code !== 200) {
      return {
        ok: false,
        provider: 'glm',
        label: 'GLM Coding Plan',
        error: data?.msg || 'unknown error',
        raw: data,
      };
    }
    return {
      ok: true,
      provider: 'glm',
      label: 'GLM Coding Plan',
      summary: summarize(data.data, data),
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'glm',
      label: 'GLM Coding Plan',
      error: err.message,
    };
  }
}

/** Turn GLM's limits[] into a normalized, dashboard-friendly shape. */
function summarize(d, full) {
  const level = d?.level ? LEVEL_LABEL[d.level] || d.level : null;
  const now = Date.now();
  const limits = (d?.limits || []).map((l) => normalizeLimit(l, now));
  return { level, limits, plan_label: level ? `GLM ${level}` : 'GLM' };
}

function normalizeLimit(l, now) {
  const hasMcp = Array.isArray(l.usageDetails) && l.usageDetails.length > 0;
  const period = l.nextResetTime ? periodLabel(l.nextResetTime - now) : null;

  let kind;
  if (hasMcp) kind = 'MCP';
  else if (l.type === 'TIME_LIMIT') kind = 'Prompts';
  else if (l.type === 'TOKENS_LIMIT') kind = 'Tokens';
  else kind = l.type || 'Limit';

  const label = period ? `${kind} · ${period}` : kind;

  const out = {
    label,
    kind,
    percent: typeof l.percentage === 'number' ? l.percentage : null,
  };
  if (typeof l.currentValue === 'number' && typeof l.usage === 'number') {
    out.used = l.currentValue;
    out.total = l.usage;
  }
  if (l.nextResetTime) out.reset_at = new Date(l.nextResetTime).toISOString();
  if (hasMcp) {
    out.detail = l.usageDetails
      .filter((u) => u.usage > 0)
      .map((u) => `${u.modelCode}: ${u.usage}`)
      .join(', ');
  }
  return out;
}

/** Derive a human period label from a reset delta (ms). */
function periodLabel(deltaMs) {
  const h = deltaMs / 3_600_000;
  if (h <= 12) return '5h window';
  if (h <= 8 * 24) return 'weekly';
  if (h <= 35 * 24) return 'monthly';
  return `~${Math.round(h / 24)}d`;
}
