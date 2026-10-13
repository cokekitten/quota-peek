import { execFileSync } from 'node:child_process';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * Cursor (cursor.com individual plans: Pro / Pro+ / Ultra).
 *
 * The dashboard's own numbers, straight from the Connect-RPC endpoints the
 * web Spending page calls:
 *
 *   POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *     → planUsage.autoPercentUsed (Cursor Models pool) and .apiPercentUsed
 *       (Other Models pool), plus the monthly billing-cycle bounds.
 *   POST api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus
 *     → Grok Bot's own *weekly* allowance (usagePercent + nextResetTimestampUtc)
 *       and the plan name. Optional: a failure just drops that row.
 *
 * The percentages arrive pre-computed server-side. The per-pool dollar
 * amounts exist in the protobuf schema (autoSpend/autoLimit/apiSpend/apiLimit)
 * but the backend withholds them, and the published `limit` cents field is a
 * legacy figure no bar divides by — so the card shows exactly the two pool
 * percentages the official dashboard shows, and nothing derived. Same for
 * Grok Bot: its window is 7 days and resets on its own clock, not the cycle.
 *
 * An On-Demand row appears only when the account actually has a spend limit
 * configured (individualLimit/overallLimit present); disabled on-demand
 * (noUsageBasedAllowed) stays silent like the dashboard's "Disabled" state.
 *
 * Credentials: the `cursor-agent` CLI stores its session JWT in the macOS
 * keychain under `cursor-access-token` — that is the default on a Mac and
 * needs no configuration. Elsewhere (Docker, Linux, extra accounts) set
 * CURSOR_ACCESS_TOKEN (or _2, _3, …) to the token. There is no refresh
 * half in the keychain entry, so an expired token means re-running
 * `cursor-agent login`; the card says so.
 */

const DEFAULT_BASE_URL = 'https://api2.cursor.sh';
const USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const SAND_PATH = '/aiserver.v1.DashboardService/GetSandUsageStatus';
const KEYCHAIN_SERVICE = 'cursor-access-token';
const TIMEOUT_MS = Number(process.env.CURSOR_TIMEOUT_MS || 15000);

// Env vars forming one account's config; the token marks it.
const ENV_VARS = ['CURSOR_ACCESS_TOKEN', 'CURSOR_BASE_URL'];
const TRIGGER_VARS = ['CURSOR_ACCESS_TOKEN'];

interface CursorAccount {
  /** Env token; account 1 may fall back to the macOS keychain. */
  token?: string;
  tokenEnv: string;
  baseUrl: string;
}

/** Wire format of GetCurrentPeriodUsage (individual-plan shape). */
interface UsageResponse {
  billingCycleStart?: string; // unix ms, as a string
  billingCycleEnd?: string;
  planUsage?: {
    autoPercentUsed?: number;
    apiPercentUsed?: number;
  };
  spendLimitUsage?: {
    totalSpend?: number;
    individualLimit?: number;
    individualUsed?: number;
    overallLimit?: number;
    overallUsed?: number;
  };
}

/** Wire format of GetSandUsageStatus (Grok Bot's weekly allowance). */
interface SandResponse {
  usagePercent?: number;
  nextResetTimestampUtc?: string; // RFC3339
  cursorPlanName?: string;
}

/** One decimal, clamped — a 0.072% pool must read as 0.1, not vanish to 0. */
function pct1(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** Type-guarding finiteness — Number.isFinite alone narrows nothing. */
function isFiniteNumber(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Unix-ms string → ISO, or undefined for absent/garbage. */
function isoFromMs(v: string | undefined): string | undefined {
  const n = v === undefined || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

/** RFC3339 → ISO, or undefined. */
function isoFromRfc3339(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// ---------------------------------------------------------------- keychain

function keychainEnabled(): boolean {
  return process.platform === 'darwin' && process.env.CURSOR_NO_KEYCHAIN !== '1';
}

/** The JWT the cursor-agent CLI stored, or undefined. Never throws. */
function readKeychainToken(): string | undefined {
  if (!keychainEnabled()) return undefined;
  try {
    const out = execFileSync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]) as unknown as string | Buffer;
    const tok = (typeof out === 'string' ? out : out.toString('utf8')).trim();
    return tok || undefined;
  } catch {
    return undefined; // item missing, or `security` unavailable
  }
}

/** Env values that mark the provider as configured. */
export function isConfigured(): boolean {
  if (
    readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some((a) =>
      Boolean(a.env.CURSOR_ACCESS_TOKEN),
    )
  ) {
    return true;
  }
  return keychainEnabled() && keychainItemExists();
}

/** Cheap local probe — does the keychain item exist at all? No secret read. */
function keychainItemExists(): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- fetch

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** One Connect-RPC POST with the headers api2.cursor.sh expects. */
async function rpc<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const resp = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new HttpError(resp.status);
  return (await resp.json()) as T;
}

export function fetchCursorUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS })
    // Account 1 stays even without an env token — it may use the keychain.
    .filter(({ key, env }) => key === '1' || Boolean(env.CURSOR_ACCESS_TOKEN))
    .map(({ key, env }) => ({
      key,
      config: {
        token: env.CURSOR_ACCESS_TOKEN,
        tokenEnv: accountEnvName('CURSOR_ACCESS_TOKEN', key),
        baseUrl: (env.CURSOR_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
      } satisfies CursorAccount,
    }));
  return fetchMultiAccount(accounts, fetchCursorAccount, {
    provider: 'cursor',
    label: 'Cursor',
  });
}

async function fetchCursorAccount(cfg: CursorAccount): Promise<ProviderResult> {
  const fail = (error: string): ProviderResult => ({
    ok: false,
    provider: 'cursor',
    label: 'Cursor',
    error,
  });

  const token = cfg.token ?? readKeychainToken();
  if (!token) {
    return fail(
      `no token — set ${cfg.tokenEnv} or log in via \`cursor-agent login\` (macOS keychain)`,
    );
  }

  let usage: UsageResponse;
  try {
    usage = await rpc<UsageResponse>(cfg.baseUrl, USAGE_PATH, token);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return fail(
        `token rejected (HTTP ${err.status}) — run \`cursor-agent login\` again, or set a fresh ${cfg.tokenEnv}`,
      );
    }
    return fail(err instanceof Error ? err.message : String(err));
  }

  const pu = usage.planUsage;
  const auto = pu?.autoPercentUsed;
  const api = pu?.apiPercentUsed;
  if (pu === undefined || (!isFiniteNumber(auto) && !isFiniteNumber(api))) {
    // Team/enterprise payloads can omit planUsage outright — a silent empty
    // card would hide the shape change; surface it instead.
    return fail('response carried no planUsage percentages (team/enterprise shape?)');
  }

  const cycleEnd = isoFromMs(usage.billingCycleEnd);
  const limits: UsageLimit[] = [];

  if (isFiniteNumber(auto)) {
    limits.push({ label: 'Cursor Models', kind: 'cursor-models', percent: pct1(auto), resetAt: cycleEnd });
  }
  if (isFiniteNumber(api)) {
    limits.push({ label: 'Other Models', kind: 'other-models', percent: pct1(api), resetAt: cycleEnd });
  }

  // Grok Bot: a separate weekly allowance on its own reset clock. Optional —
  // it also carries the plan name, so its failure only drops the row.
  let planName: string | undefined;
  try {
    const sand = await rpc<SandResponse>(cfg.baseUrl, SAND_PATH, token);
    planName = sand.cursorPlanName || undefined;
    if (isFiniteNumber(sand.usagePercent)) {
      limits.push({
        label: 'Grok Bot',
        kind: 'grok-bot',
        percent: pct1(sand.usagePercent),
        resetAt: isoFromRfc3339(sand.nextResetTimestampUtc),
      });
    }
  } catch {
    // Non-fatal by design.
  }

  // On-Demand: only when a spend limit exists. Disabled (noUsageBasedAllowed)
  // or absent stays silent, mirroring the dashboard's "Disabled" state.
  const sl = usage.spendLimitUsage;
  const odLimit = sl?.individualLimit ?? sl?.overallLimit;
  const odUsed = sl?.individualUsed ?? sl?.overallUsed ?? sl?.totalSpend;
  if (odLimit !== undefined && odLimit > 0 && isFiniteNumber(odUsed)) {
    limits.push({
      label: 'On-Demand',
      kind: 'spend',
      percent: pct1((odUsed / odLimit) * 100),
      used: Math.round(odUsed) / 100,
      total: odLimit / 100,
      unit: '$',
      resetAt: cycleEnd,
    });
  }

  return {
    ok: true,
    provider: 'cursor',
    label: 'Cursor',
    summary: {
      planLabel: planName,
      // Same plan name ⇒ same pool denominators ($-wise), so cross-account
      // merges of these percent rows are exact rather than ≈.
      planKey: planName,
      limits,
    },
  };
}
