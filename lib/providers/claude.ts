import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderResult, UsageLimit } from './types';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH || path.join(CONFIG_DIR, '.credentials.json');
const USAGE_API =
  process.env.CLAUDE_USAGE_API || 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 15000);

// Anthropic's usage API rate-limits aggressively (5-min window). Cache successes
// briefly so manual/parallel refreshes don't trip a 429, and serve the last
// good result for a few minutes if a fetch fails (matches claude-hud's strategy).
const CACHE_TTL_MS = 60_000; // serve fresh cache for 1 min
const STALE_TTL_MS = 5 * 60_000; // serve last-good on error for up to 5 min
let cache: { result: ProviderResult; ts: number } | null = null;

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
    expiresAt?: number;
  };
}
interface UsageWindow {
  utilization?: number;
  resets_at?: string | null;
}
interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  seven_day_opus?: UsageWindow;
}

/**
 * Claude Code usage via Anthropic's OAuth usage API — the same structured
 * source the `claude-hud` statusline plugin and Claude Code itself use.
 *
 * Reads the OAuth access token from ~/.claude/.credentials.json and calls
 * GET /api/oauth/usage, which returns { five_hour, seven_day, ... } with
 * utilization (0-100) and ISO resets_at per window. Far more reliable than
 * parsing `claude -p /usage` (AI-generated text).
 */
export async function fetchClaudeUsage(): Promise<ProviderResult> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.result;
  }
  const result = await fetchLive();
  if (result.ok) {
    cache = { result, ts: now };
    return result;
  }
  // Fetch failed (429 / network / etc.) — serve last good result if still fresh.
  if (cache && now - cache.ts < STALE_TTL_MS) {
    return { ...cache.result, stale: true };
  }
  return result;
}

async function fetchLive(): Promise<ProviderResult> {
  // Custom API endpoint (e.g. a proxy / Bedrock) → OAuth usage API doesn't apply.
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_BASE_URL || '').trim();
  if (baseUrl) {
    try {
      if (new URL(baseUrl).origin !== 'https://api.anthropic.com') {
        return {
          ok: false,
          provider: 'claude',
          label: 'Claude Code',
          error: 'Custom ANTHROPIC_BASE_URL detected — OAuth usage API unavailable',
        };
      }
    } catch {
      /* ignore malformed URL, proceed */
    }
  }

  // 1. Read OAuth token + subscription type.
  let token: string;
  let subscriptionType: string;
  try {
    const file = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    const creds = (JSON.parse(file) as Credentials)?.claudeAiOauth;
    token = creds?.accessToken || '';
    subscriptionType = creds?.subscriptionType || '';
    if (!token) {
      return {
        ok: false,
        provider: 'claude',
        label: 'Claude Code',
        error:
          'No OAuth accessToken in ~/.claude/.credentials.json (not logged in via subscription?)',
      };
    }
  } catch (err) {
    return {
      ok: false,
      provider: 'claude',
      label: 'Claude Code',
      error: `Cannot read credentials (${CREDENTIALS_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // 2. Call the usage API.
  let data: UsageResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(USAGE_API, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (resp.status === 429) {
      return {
        ok: false,
        provider: 'claude',
        label: 'Claude Code',
        error: 'Rate limited by Anthropic usage API — retry in a minute',
      };
    }
    if (resp.status === 401) {
      return {
        ok: false,
        provider: 'claude',
        label: 'Claude Code',
        error: 'OAuth token expired — run `claude` interactively to refresh, then retry',
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        provider: 'claude',
        label: 'Claude Code',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    data = (await resp.json()) as UsageResponse;
  } catch (err) {
    return {
      ok: false,
      provider: 'claude',
      label: 'Claude Code',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Normalize into limits.
  const planName = planLabel(subscriptionType);
  const limits: UsageLimit[] = [];
  pushWindow(limits, '5h window', 'five_hour', data.five_hour);
  pushWindow(limits, 'Week · all models', 'seven_day', data.seven_day);
  if (data.seven_day_sonnet) {
    pushWindow(limits, 'Week · Sonnet only', 'seven_day_sonnet', data.seven_day_sonnet);
  }
  if (data.seven_day_opus) {
    pushWindow(limits, 'Week · Opus only', 'seven_day_opus', data.seven_day_opus);
  }

  return {
    ok: true,
    provider: 'claude',
    label: 'Claude Code',
    summary: { planLabel: planName ? `Claude ${planName}` : 'Claude Code', limits },
    raw: data as unknown,
  };
}

function pushWindow(
  out: UsageLimit[],
  label: string,
  kind: string,
  w?: UsageWindow,
): void {
  if (!w) return;
  const limit: UsageLimit = {
    label,
    kind,
    percent: clampPercent(w.utilization),
  };
  if (w.resets_at) limit.resetAt = w.resets_at;
  out.push(limit);
}

function clampPercent(v?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(100, v)));
}

function planLabel(subscriptionType: string): string | null {
  const s = (subscriptionType || '').toLowerCase();
  if (s.includes('max')) return 'Max';
  if (s.includes('pro')) return 'Pro';
  if (s.includes('team')) return 'Team';
  return null;
}
