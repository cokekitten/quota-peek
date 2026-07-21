import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderResult, UsageLimit } from './types';

const CREDS_PATH =
  process.env.KIMI_CREDENTIALS_PATH ||
  path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
const USAGE_URL = process.env.KIMI_USAGE_URL || 'https://api.kimi.com/coding/v1/usages';
const TOKEN_URL = process.env.KIMI_TOKEN_URL || 'https://auth.kimi.com/api/oauth/token';
// Public OAuth client_id used by the official Kimi Code CLI.
const CLIENT_ID = process.env.KIMI_CLIENT_ID || '17e5f671-d194-4dfb-9706-5516cb48c098';
const TIMEOUT_MS = Number(process.env.KIMI_TIMEOUT_MS || 15000);
// Refresh a bit early so a request never rides on a borderline token.
const EXPIRY_SKEW_S = 60;

interface KimiCredentials {
  access_token?: string;
  refresh_token?: string;
  /** Unix seconds. */
  expires_at?: number;
  [key: string]: unknown;
}

interface KimiQuota {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

interface KimiUsagesResponse {
  user?: {
    membership?: { level?: string };
  };
  /** Weekly subscription quota. */
  usage?: KimiQuota;
  /** Shorter rate-limit windows (e.g. the rolling 5h window). */
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: KimiQuota;
  }>;
}

/**
 * Kimi (Kimi Code membership) usage via the same endpoint the CLI's `/usage`
 * command and the Kimi Code Console use: GET api.kimi.com/coding/v1/usages.
 *
 * Auth: OAuth credentials written by the CLI login at
 * ~/.kimi-code/credentials/kimi-code.json (access token lives ~15 min; we
 * refresh via auth.kimi.com and write the rotated tokens back). Alternatively
 * set KIMI_API_KEY to an API Key from the Kimi Code Console to skip OAuth.
 */
export async function fetchKimiUsage(): Promise<ProviderResult> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return {
      ok: false,
      provider: 'kimi',
      label: 'Kimi',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return {
        ok: false,
        provider: 'kimi',
        label: 'Kimi',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }

    const data = (await resp.json()) as KimiUsagesResponse;
    const limits: UsageLimit[] = [];

    for (const entry of data.limits ?? []) {
      const w = entry.window || {};
      const is5h =
        (w.timeUnit === 'TIME_UNIT_MINUTE' && w.duration === 300) ||
        (w.timeUnit === 'TIME_UNIT_HOUR' && w.duration === 5);
      // The card renders 5h + weekly slots; other short windows are skipped.
      if (!is5h) continue;
      const quota = quotaLimit(entry.detail, '5h Window', '5h');
      if (quota) limits.push(quota);
    }

    const weekly = quotaLimit(data.usage, 'Weekly', 'weekly');
    if (weekly) limits.push(weekly);

    const level = data.user?.membership?.level;
    return {
      ok: true,
      provider: 'kimi',
      label: 'Kimi',
      summary: {
        planLabel: level ? `Kimi ${levelLabel(level)}` : 'Kimi',
        limits,
      },
      raw: data as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'kimi',
      label: 'Kimi',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Resolve a usable access token: KIMI_API_KEY, or OAuth file (refresh if needed). */
async function getAccessToken(): Promise<string> {
  const apiKey = process.env.KIMI_API_KEY;
  if (apiKey) return apiKey;

  let creds: KimiCredentials;
  try {
    creds = JSON.parse(await fs.readFile(CREDS_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read credentials (${CREDS_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }. Log in via the Kimi Code CLI, or set KIMI_API_KEY.`,
    );
  }

  const nowS = Math.floor(Date.now() / 1000);
  const expired = typeof creds.expires_at === 'number' && creds.expires_at <= nowS + EXPIRY_SKEW_S;
  if (creds.access_token && !expired) return creds.access_token;

  if (!creds.refresh_token) {
    throw new Error('Access token expired and no refresh_token available — run `kimi` to log in again.');
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Token refresh failed (HTTP ${resp.status}): ${data.error_description || 'unknown'} — run \`kimi\` to log in again.`,
    );
  }

  // Refresh tokens rotate: persist the new pair or the next refresh breaks.
  const updated: KimiCredentials = {
    ...creds,
    access_token: data.access_token,
    refresh_token: data.refresh_token || creds.refresh_token,
    expires_at: nowS + (data.expires_in ?? 900),
  };
  try {
    await fs.writeFile(CREDS_PATH, JSON.stringify(updated, null, 2), 'utf8');
  } catch {
    /* non-fatal: token still works for this run */
  }
  return data.access_token;
}

/** Map one quota block { limit, used, resetTime } (string numbers) into UsageLimit. */
function quotaLimit(q: KimiQuota | undefined, label: string, kind: string): UsageLimit | null {
  if (!q) return null;
  const limit = Number(q.limit);
  const used = Number(q.used);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  const out: UsageLimit = {
    label,
    kind,
    percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
  };
  if (q.resetTime) {
    const t = new Date(q.resetTime);
    if (!Number.isNaN(t.getTime())) out.resetAt = t.toISOString();
  }
  return out;
}

/**
 * Map the API's membership LEVEL_* enum to Kimi's consumer (tempo) plan names.
 * Live-observed anchors: LEVEL_BASIC = Moderato, LEVEL_INTERMEDIATE = Allegretto,
 * LEVEL_ADVANCED = Allegro; LEVEL_PREMIUM = Vivace is community consensus.
 * Unknown values fall back to the raw word ("LEVEL_X" -> "X").
 */
const LEVEL_PLAN: Record<string, string> = {
  LEVEL_FREE: 'Adagio',
  LEVEL_BASIC: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_PREMIUM: 'Vivace',
};

function levelLabel(level: string): string {
  if (LEVEL_PLAN[level]) return LEVEL_PLAN[level];
  const s = level.replace(/^LEVEL_/, '').toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : level;
}
