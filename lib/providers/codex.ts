import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderResult, UsageLimit } from './types';

const AUTH_PATH =
  process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const USAGE_URL =
  process.env.CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';

interface CodexResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
}
interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number; // seconds
}

/**
 * Codex (ChatGPT) usage via the internal wham endpoint.
 * Reads credentials from ~/.codex/auth.json.
 * NOTE: internal endpoint, may change without notice.
 */
export async function fetchCodexUsage(): Promise<ProviderResult> {
  let auth: { tokens?: { access_token?: string; account_id?: string } };
  try {
    const file = await fs.readFile(AUTH_PATH, 'utf8');
    auth = JSON.parse(file);
  } catch (err) {
    return {
      ok: false,
      provider: 'codex',
      label: 'Codex',
      error: `Cannot read auth file (${AUTH_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) {
    return {
      ok: false,
      provider: 'codex',
      label: 'Codex',
      error: 'Missing access_token / account_id in auth.json',
    };
  }

  try {
    const resp = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        Accept: 'application/json',
        originator: 'codex_cli_rs',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!resp.ok) {
      return {
        ok: false,
        provider: 'codex',
        label: 'Codex',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const data = (await resp.json()) as CodexResponse;
    const rl = data?.rate_limit || {};
    const limits: UsageLimit[] = [
      windowLimit('Primary', rl.primary_window),
      windowLimit('Secondary', rl.secondary_window),
    ].filter((l): l is UsageLimit => l !== null);

    const planType = data.plan_type ?? null;
    return {
      ok: true,
      provider: 'codex',
      label: 'Codex',
      summary: {
        plan_type: planType,
        planLabel: planType ? `Codex ${planType}` : 'Codex',
        limits,
      },
      raw: data as unknown,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'codex',
      label: 'Codex',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a Codex rate-limit window into the shared limit shape. */
function windowLimit(name: string, w?: CodexWindow): UsageLimit | null {
  if (!w) return null;
  const period = w.limit_window_seconds ? periodLabel(w.limit_window_seconds) : null;
  const out: UsageLimit = {
    label: period ? `${name} · ${period}` : name,
    kind: name,
    percent: typeof w.used_percent === 'number' ? w.used_percent : 0,
  };
  if (w.reset_at) out.resetAt = new Date(w.reset_at * 1000).toISOString();
  return out;
}

function periodLabel(seconds: number): string {
  const h = seconds / 3600;
  if (h <= 12) return '5h window';
  if (h <= 8 * 24) return 'weekly';
  if (h <= 35 * 24) return 'monthly';
  return `~${Math.round(h / 24)}d`;
}
