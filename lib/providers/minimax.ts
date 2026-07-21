import type { ProviderResult, UsageLimit } from './types';

const BASE_URL = (process.env.MINIMAX_BASE_URL || 'https://www.minimaxi.com').replace(/\/$/, '');
const REMAINS_PATH = '/v1/token_plan/remains';

interface MinimaxModelRemain {
  start_time?: number;
  end_time?: number;
  remains_time?: number;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  current_interval_status?: number;
  model_name?: string;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  current_weekly_status?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  weekly_remains_time?: number;
}

interface MinimaxData {
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remains_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remains_time?: number;
  interval_total_count?: number;
  interval_usage_count?: number;
  weekly_total_count?: number;
  weekly_usage_count?: number;
  remains_time?: number;
  current_interval_remaining_percent?: number;
  current_weekly_remaining_percent?: number;
}

interface MinimaxRemainsResponse {
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  data?: MinimaxData;
  model_remains?: MinimaxModelRemain[];
}

/**
 * MiniMax (domestic China endpoint by default) Token Plan usage.
 * Uses the official /v1/token_plan/remains endpoint with Subscription Key (Bearer).
 *
 * Quotas are 5-hour rolling + weekly, matching the dashboard format.
 * Defaults to domestic: https://www.minimaxi.com
 * Set MINIMAX_BASE_URL=https://www.minimax.io for global if needed.
 */
export async function fetchMinimaxUsage(): Promise<ProviderResult> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      provider: 'minimax',
      label: 'MiniMax',
      error: 'MINIMAX_API_KEY not set (use your Token Plan Subscription Key)',
    };
  }

  try {
    const resp = await fetch(`${BASE_URL}${REMAINS_PATH}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      return {
        ok: false,
        provider: 'minimax',
        label: 'MiniMax',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }

    const raw = (await resp.json()) as MinimaxRemainsResponse;

    if (raw.base_resp && raw.base_resp.status_code !== 0 && raw.base_resp.status_code !== undefined) {
      return {
        ok: false,
        provider: 'minimax',
        label: 'MiniMax',
        error: raw.base_resp.status_msg || `API error ${raw.base_resp.status_code}`,
        raw: raw as unknown,
      };
    }

    // Support both old flat/data shape and the current model_remains array (seen on domestic)
    let modelData: any = null;
    if (Array.isArray(raw.model_remains) && raw.model_remains.length > 0) {
      // Prefer "general" or first entry
      modelData = raw.model_remains.find((m: any) => m.model_name === 'general') || raw.model_remains[0];
    } else {
      modelData = (raw.data || raw) as any;
    }

    const limits: UsageLimit[] = [];

    // 5h Window
    let i5hPercent = 0;
    const i5hRemains = modelData?.current_interval_remaining_percent;
    if (typeof i5hRemains === 'number') {
      i5hPercent = Math.max(0, Math.min(100, 100 - i5hRemains)); // remaining -> used
    } else {
      const total = modelData?.current_interval_total_count ?? modelData?.interval_total_count ?? 0;
      const usedOrRem = modelData?.current_interval_usage_count ?? modelData?.interval_usage_count;
      if (total > 0 && typeof usedOrRem === 'number') {
        const used = usedOrRem <= total ? total - usedOrRem : usedOrRem;
        i5hPercent = Math.round((used / total) * 100);
      }
    }
    const i5hReset = modelData?.remains_time ?? modelData?.current_interval_remains_time;
    const i5h: UsageLimit = {
      label: '5h Window',
      kind: '5h',
      percent: clampPercent(i5hPercent),
    };
    if (typeof i5hReset === 'number' && i5hReset > 0) {
      const ms = i5hReset > 1_000_000 ? i5hReset : i5hReset * 1000; // ms vs seconds heuristic
      i5h.resetAt = new Date(Date.now() + ms).toISOString();
    }
    limits.push(i5h);

    // Weekly
    let weeklyPercent = 0;
    const wRemains = modelData?.current_weekly_remaining_percent;
    if (typeof wRemains === 'number') {
      weeklyPercent = Math.max(0, Math.min(100, 100 - wRemains));
    } else {
      const total = modelData?.current_weekly_total_count ?? modelData?.weekly_total_count ?? 0;
      const usedOrRem = modelData?.current_weekly_usage_count ?? modelData?.weekly_usage_count;
      if (total > 0 && typeof usedOrRem === 'number') {
        const used = usedOrRem <= total ? total - usedOrRem : usedOrRem;
        weeklyPercent = Math.round((used / total) * 100);
      }
    }
    const wReset = modelData?.weekly_remains_time ?? modelData?.current_weekly_remains_time;
    const weekly: UsageLimit = {
      label: 'Weekly',
      kind: 'weekly',
      percent: clampPercent(weeklyPercent),
    };
    if (typeof wReset === 'number' && wReset > 0) {
      const ms = wReset > 1_000_000 ? wReset : wReset * 1000;
      weekly.resetAt = new Date(Date.now() + ms).toISOString();
    }
    limits.push(weekly);

    return {
      ok: true,
      provider: 'minimax',
      label: 'MiniMax',
      summary: {
        planLabel: process.env.MINIMAX_PLAN_LABEL || inferPlanLabel(raw),
        limits,
      },
      raw: raw as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'minimax',
      label: 'MiniMax',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * The remains endpoint exposes no tier field. The only reliable in-payload
 * signal: Ultra is the sole tier that ships video generations (5/day), so a
 * video bucket with non-zero totals implies Ultra. Everything else stays
 * generic — set MINIMAX_PLAN_LABEL to override.
 */
function inferPlanLabel(raw: MinimaxRemainsResponse): string {
  const video = Array.isArray(raw.model_remains)
    ? raw.model_remains.find((m) => m.model_name === 'video')
    : undefined;
  const videoTotal =
    (video?.current_interval_total_count ?? 0) + (video?.current_weekly_total_count ?? 0);
  if (videoTotal > 0) return 'MiniMax Ultra';
  return 'MiniMax Token Plan';
}
