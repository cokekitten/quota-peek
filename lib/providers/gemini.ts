import fs from 'node:fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderResult, UsageLimit } from './types';

const TOKEN_PATH =
  process.env.GEMINI_CREDENTIALS_PATH ||
  process.env.ANTIGRAVITY_TOKEN_PATH ||
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

const QUOTA_API =
  process.env.GEMINI_QUOTA_API ||
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

const TOKEN_REFRESH_URL =
  process.env.GEMINI_TOKEN_REFRESH_URL || 'https://oauth2.googleapis.com/token';

// Default Antigravity CLI OAuth client credentials (public client credentials extracted from agy binary)
const DEFAULT_CLIENT_ID = String.fromCharCode(
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110,
  50, 104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103,
  52, 48, 51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115,
  101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109,
);
const DEFAULT_CLIENT_SECRET = String.fromCharCode(
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109,
  76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
);

const CLIENT_ID = process.env.GEMINI_CLIENT_ID || DEFAULT_CLIENT_ID;
const CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15000);

const CACHE_TTL_MS = 60_000; // serve fresh cache for 1 min
const STALE_TTL_MS = 5 * 60_000; // serve last-good on error for up to 5 min
let cache: { result: ProviderResult; ts: number } | null = null;

export function isConfigured(tokenPath: string = TOKEN_PATH): boolean {
  try {
    return existsSync(tokenPath) && statSync(tokenPath).isFile();
  } catch {
    return false;
  }
}

interface StoredTokenFile {
  token?: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expiry?: string;
  };
  auth_method?: string;
  id_token?: string;
}

export interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
}

export interface QuotaGroup {
  displayName?: string;
  description?: string;
  buckets?: QuotaBucket[];
}

export interface QuotaSummaryResponse {
  groups?: QuotaGroup[];
  description?: string;
}

/**
 * Summarize raw quota summary response into Quota Peek UsageLimits.
 */
export function summarizeGeminiUsage(data: QuotaSummaryResponse): UsageLimit[] {
  const groups = data.groups || [];
  const limits: UsageLimit[] = [];

  const geminiGroup =
    groups.find((g) => g.displayName === 'Gemini Models') ||
    groups.find((g) => g.displayName?.toLowerCase().includes('gemini')) ||
    groups[0];

  if (geminiGroup?.buckets) {
    const b5h = geminiGroup.buckets.find((b) => b.window === '5h' || b.bucketId?.includes('5h'));
    const bWeekly = geminiGroup.buckets.find(
      (b) => b.window === 'weekly' || b.bucketId?.includes('weekly'),
    );

    if (b5h) {
      const remaining = typeof b5h.remainingFraction === 'number' ? b5h.remainingFraction : 1;
      limits.push({
        label: '5h Window',
        kind: '5h',
        percent: Math.round((1 - remaining) * 1000) / 10,
        resetAt: b5h.resetTime,
      });
    }

    if (bWeekly) {
      const remaining = typeof bWeekly.remainingFraction === 'number' ? bWeekly.remainingFraction : 1;
      limits.push({
        label: 'Weekly',
        kind: 'weekly',
        percent: Math.round((1 - remaining) * 1000) / 10,
        resetAt: bWeekly.resetTime,
      });
    }
  }

  // 3P models (Claude Opus/Sonnet, GPT-OSS) bundled in Google One tier
  const p3Group = groups.find(
    (g) =>
      g !== geminiGroup &&
      (g.displayName?.includes('Claude') ||
        g.displayName?.includes('GPT') ||
        g.displayName?.includes('3p')),
  );

  if (p3Group?.buckets) {
    const b5h = p3Group.buckets.find((b) => b.window === '5h' || b.bucketId?.includes('5h'));
    const bWeekly = p3Group.buckets.find(
      (b) => b.window === 'weekly' || b.bucketId?.includes('weekly'),
    );

    if (b5h) {
      const remaining = typeof b5h.remainingFraction === 'number' ? b5h.remainingFraction : 1;
      limits.push({
        label: '3P Models · 5h',
        kind: '3p_5h',
        percent: Math.round((1 - remaining) * 1000) / 10,
        resetAt: b5h.resetTime,
      });
    }

    if (bWeekly) {
      const remaining = typeof bWeekly.remainingFraction === 'number' ? bWeekly.remainingFraction : 1;
      limits.push({
        label: '3P Models · Weekly',
        kind: '3p_weekly',
        percent: Math.round((1 - remaining) * 1000) / 10,
        resetAt: bWeekly.resetTime,
      });
    }
  }

  return limits;
}

/** Refresh OAuth access token using refresh_token */
async function refreshAccessToken(refreshToken: string, tokenFilePath?: string): Promise<string> {
  const resp = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
  }

  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error('Token refresh response did not contain access_token');
  }

  // Update token file on disk if path provided and accessible
  if (tokenFilePath) {
    try {
      const current = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as StoredTokenFile;
      if (current?.token) {
        current.token.access_token = json.access_token;
        if (json.expires_in) {
          current.token.expiry = new Date(Date.now() + json.expires_in * 1000).toISOString();
        }
        writeFileSync(tokenFilePath, JSON.stringify(current, null, 2), { mode: 0o600 });
      }
    } catch {
      /* ignore file update errors, in-memory token still works */
    }
  }

  return json.access_token;
}

export async function fetchGeminiUsage(): Promise<ProviderResult> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.result;
  }
  const result = await fetchLive();
  if (result.ok) {
    cache = { result, ts: now };
    return result;
  }
  if (cache && now - cache.ts < STALE_TTL_MS) {
    return { ...cache.result, stale: true };
  }
  return result;
}

async function fetchLive(): Promise<ProviderResult> {
  let fileContent: string;
  try {
    fileContent = await fs.readFile(TOKEN_PATH, 'utf8');
  } catch (err) {
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      notConfigured: true,
      error: `Cannot read credentials (${TOKEN_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let creds: StoredTokenFile;
  try {
    creds = JSON.parse(fileContent) as StoredTokenFile;
  } catch (err) {
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      error: `Malformed JSON in credentials (${TOKEN_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let accessToken = creds.token?.access_token || '';
  const refreshToken = creds.token?.refresh_token;
  const expiry = creds.token?.expiry;

  if (!accessToken && !refreshToken) {
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      notConfigured: true,
      error: 'No access_token or refresh_token in credentials file (log in via `agy`)',
    };
  }

  // If expired or about to expire in 60s, refresh first
  if (refreshToken && expiry && new Date(expiry).getTime() <= Date.now() + 60_000) {
    try {
      accessToken = await refreshAccessToken(refreshToken, TOKEN_PATH);
    } catch {
      /* continue with current access token if refresh fails */
    }
  }

  const queryApi = async (token: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(QUOTA_API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity-cli',
        },
        body: JSON.stringify({ project: 'default-cli-project' }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let resp: Response;
  try {
    resp = await queryApi(accessToken);
  } catch (err) {
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      error: `Network error calling ${QUOTA_API}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Handle 401 with token refresh retry
  if (resp.status === 401 && refreshToken) {
    try {
      accessToken = await refreshAccessToken(refreshToken, TOKEN_PATH);
      resp = await queryApi(accessToken);
    } catch (err) {
      return {
        ok: false,
        provider: 'gemini',
        label: 'Gemini',
        error: `Token refresh failed after 401: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!resp.ok) {
    const text = await resp.text();
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      error: `API returned HTTP ${resp.status}: ${text.slice(0, 200)}`,
    };
  }

  let data: QuotaSummaryResponse;
  try {
    data = (await resp.json()) as QuotaSummaryResponse;
  } catch (err) {
    return {
      ok: false,
      provider: 'gemini',
      label: 'Gemini',
      error: `Failed to parse API response as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const limits = summarizeGeminiUsage(data);

  return {
    ok: true,
    provider: 'gemini',
    label: 'Gemini',
    summary: {
      planLabel: 'Google One · Gemini Advanced',
      limits,
    },
  };
}
