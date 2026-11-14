import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderResult, UsageLimit } from './types';
import { accountEnvName, fetchMultiAccount, readIndexedAccounts } from './accounts';

/**
 * Devin (Cognition) plan quota.
 *
 * The devin CLI's own /usage screen is what this provider mirrors: one
 * Connect-RPC call, `GetUserStatus`, answered by the same server the CLI
 * talks to (server.codeium.com, or whatever api_server_url the sign-in
 * recorded):
 *
 *   POST /exa.seat_management_pb.SeatManagementService/GetUserStatus
 *     metadata.apiKey = the Devin key (the CLI keeps it in credentials.toml
 *     as windsurf_api_key; a service user's cog_… key works the same)
 *     → userStatus.planStatus:
 *         dailyQuotaRemainingPercent  / dailyQuotaResetAtUnix
 *         weeklyQuotaRemainingPercent / weeklyQuotaResetAtUnix
 *         acuLimit / acuConsumed / overageBalanceMicros / planEnd
 *         planInfo.billingStrategy, planInfo.hideDailyQuota/hideWeeklyQuota
 *
 * The API reports what is LEFT, so a row's percent is 100 − remaining. JSON
 * leaves zero fields out: on a quota-billed plan a window that has a reset
 * time but no remaining share is used up (0% left), not absent — the devin
 * CLI's own usage view made the same mistake and lost a maxed week. A plan
 * billed another way (per-ACU) simply has no daily/weekly quota, and a missing
 * share there means no row.
 *
 * Credentials: `devin auth login` writes
 * ~/.local/share/devin/credentials.toml (XDG_DATA_HOME is honored, and
 * %APPDATA%\\devin on Windows). Account 1 falls back to that file; elsewhere
 * (Docker, extra accounts/teams) set DEVIN_API_KEY (or _2, _3, …) and
 * optionally DEVIN_BASE_URL. A 401 means the sign-in is gone — run the login
 * again or paste a fresh key.
 */

const DEFAULT_BASE_URL = 'https://server.codeium.com';
const STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const TIMEOUT_MS = Number(process.env.DEVIN_TIMEOUT_MS || 15000);
// The CLI version the request claims to be. Only cosmetic for GetUserStatus,
// but it is what the devin CLI itself sends.
const CLI_VERSION = process.env.DEVIN_CLI_VERSION || '0.1.41';

// Env vars forming one account's config; the key marks it.
const ENV_VARS = ['DEVIN_API_KEY', 'DEVIN_BASE_URL'];
const TRIGGER_VARS = ['DEVIN_API_KEY'];

export interface DevinCredentials {
  apiKey?: string;
  baseUrl?: string;
}

/** Where `devin auth login` keeps the sign-in (DEVIN_CREDENTIALS_PATH wins). */
export function defaultCredentialsPath(): string {
  if (process.env.DEVIN_CREDENTIALS_PATH) return process.env.DEVIN_CREDENTIALS_PATH;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'devin', 'credentials.toml');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devin', 'credentials.toml');
}

/** Unquote a TOML string value (the file only carries plain ASCII tokens). */
function tomlValue(raw: string): string | undefined {
  const v = raw.trim();
  if (!v || v.startsWith('#')) return undefined;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v
      .slice(1, -1)
      .replace(/\\(["\\])/g, '$1');
  }
  return v;
}

/** Read the key + API server out of credentials.toml; {} when unreadable. */
export function readDevinCredentials(file: string = defaultCredentialsPath()): DevinCredentials {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: DevinCredentials = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = tomlValue(m[2]);
    if (!value) continue;
    if (m[1] === 'windsurf_api_key') out.apiKey = value;
    else if (m[1] === 'api_server_url') out.baseUrl = value;
  }
  return out;
}

/** Configured = a key in the env (any account) or in the CLI's sign-in. */
export function isConfigured(): boolean {
  if (readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS }).some((a) =>
    Boolean(a.env.DEVIN_API_KEY),
  )) {
    return true;
  }
  return Boolean(readDevinCredentials().apiKey);
}

/** Wire format of GetUserStatus, only the fields this card reads. */
interface UserStatusResponse {
  userStatus?: {
    email?: string;
    name?: string;
    teamsTier?: string;
    planStatus?: {
      planInfo?: {
        planName?: string;
        teamsTier?: string;
        teamName?: string;
        billingStrategy?: string;
        hideDailyQuota?: boolean;
        hideWeeklyQuota?: boolean;
        devinInfo?: { accountDisplayName?: string; orgId?: string };
      };
      dailyQuotaRemainingPercent?: number | string;
      dailyQuotaResetAtUnix?: number | string;
      weeklyQuotaRemainingPercent?: number | string;
      weeklyQuotaResetAtUnix?: number | string;
      acuLimit?: number | string;
      acuConsumed?: number | string;
      overageBalanceMicros?: number | string;
      planEnd?: string;
    };
  };
}

interface DevinAccount {
  /** Env key; account 1 may fall back to the CLI's credentials.toml. */
  apiKey?: string;
  apiKeyEnv: string;
  baseUrl?: string;
  /** Only account 1 reads the CLI's sign-in. */
  credentialsPath: string;
}

/** Finite number from a JSON number or numeric string; undefined otherwise. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** One decimal, clamped — the dashboard shows percent with one decimal. */
function pct1(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** Unix seconds → ISO, or undefined for absent/garbage/non-positive. */
function isoFromUnix(v: unknown): string | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

/** RFC3339 → ISO, or undefined. */
function isoFromRfc3339(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * TEAMS_TIER_DEVIN_PRO → "Devin Pro", as `devin auth status` names the plan
 * (the CLI drops the tier's V2 version suffix).
 */
export function tierName(tier: unknown): string | undefined {
  const name = String(tier ?? '')
    .replace(/^TEAMS_TIER_/, '')
    .split('_')
    .filter((w) => w && w !== 'UNSPECIFIED' && !/^V\d+$/.test(w))
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');
  return name || undefined;
}

/** What Devin calls the platform in GetUserStatus's metadata. */
function osName(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

/** Connect error body → "code: message", or undefined when it isn't one. */
function connectError(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { code?: string; message?: string };
    if (!body?.code && !body?.message) return undefined;
    return [body.code, body.message].filter(Boolean).join(': ');
  } catch {
    return undefined;
  }
}

export function fetchDevinUsage(): Promise<ProviderResult> {
  const accounts = readIndexedAccounts({ vars: ENV_VARS, triggerVars: TRIGGER_VARS })
    // Account 1 stays even without an env key — it may use the CLI sign-in.
    .filter(({ key, env }) => key === '1' || Boolean(env.DEVIN_API_KEY))
    .map(({ key, env }) => ({
      key,
      config: {
        apiKey: env.DEVIN_API_KEY,
        apiKeyEnv: accountEnvName('DEVIN_API_KEY', key),
        baseUrl: env.DEVIN_BASE_URL?.replace(/\/+$/, ''),
        credentialsPath: defaultCredentialsPath(),
      } satisfies DevinAccount,
    }));
  return fetchMultiAccount(accounts, fetchDevinAccount, {
    provider: 'devin',
    label: 'Devin',
  });
}

async function fetchDevinAccount(cfg: DevinAccount): Promise<ProviderResult> {
  const fail = (error: string): ProviderResult => ({
    ok: false,
    provider: 'devin',
    label: 'Devin',
    error,
  });

  const creds = readDevinCredentials(cfg.credentialsPath);
  const apiKey = cfg.apiKey || creds.apiKey;
  if (!apiKey) {
    return fail(
      `no Devin key — set ${cfg.apiKeyEnv}, or log in via \`devin auth login\` (${cfg.credentialsPath})`,
    );
  }
  const baseUrl =
    cfg.baseUrl || creds.baseUrl?.replace(/\/+$/, '') || DEFAULT_BASE_URL;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}${STATUS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: JSON.stringify({
        metadata: {
          ideName: 'devin-cli',
          ideVersion: CLI_VERSION,
          extensionName: 'devin-cli',
          extensionVersion: CLI_VERSION,
          apiKey,
          locale: 'en',
          os: osName(),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    return fail(
      `Devin rejected the key (HTTP ${resp.status}) — sign in again with \`devin auth login\`, or set a fresh ${cfg.apiKeyEnv}`,
    );
  }
  if (!resp.ok) {
    const detail = connectError(text);
    return fail(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
  }

  // Devin answers an expired sign-in on the RPC path too (code unauthenticated
  // can ride a 200): treat any Connect error body as a refusal, not an empty plan.
  const refusal = connectError(text);
  if (refusal) {
    return fail(`Devin refused the request: ${refusal} — sign in again with \`devin auth login\``);
  }

  let payload: UserStatusResponse;
  try {
    payload = JSON.parse(text || '{}') as UserStatusResponse;
  } catch {
    return fail('GetUserStatus returned a body that is not JSON');
  }
  const u = payload.userStatus ?? {};
  const st = u.planStatus ?? {};
  const info = st.planInfo ?? {};
  const limits: UsageLimit[] = [];
  const quotaBilled = info.billingStrategy === 'BILLING_STRATEGY_QUOTA';
  const addWindow = (
    label: string,
    kind: string,
    left: unknown,
    reset: unknown,
    hidden: boolean | undefined,
  ) => {
    if (hidden) return;
    const at = isoFromUnix(reset);
    const remaining = num(left);
    // JSON omits a zero: on a quota-billed plan a window with a reset but no
    // remaining share is used up. A plan billed otherwise has no such quota.
    if (remaining === undefined && !(quotaBilled && at)) return;
    limits.push({
      label,
      kind,
      percent: remaining === undefined ? 100 : pct1(100 - remaining),
      ...(at ? { resetAt: at } : {}),
    });
  };
  addWindow('Daily', 'daily', st.dailyQuotaRemainingPercent, st.dailyQuotaResetAtUnix, info.hideDailyQuota);
  addWindow('Weekly', 'weekly', st.weeklyQuotaRemainingPercent, st.weeklyQuotaResetAtUnix, info.hideWeeklyQuota);

  // ACU-billed plans: the cycle's ACU allowance, shown as absolute figures.
  const acuLimit = num(st.acuLimit);
  if (acuLimit !== undefined && acuLimit > 0) {
    const acuUsed = num(st.acuConsumed) ?? 0;
    limits.push({
      label: 'ACUs',
      kind: 'credits',
      percent: pct1((acuUsed / acuLimit) * 100),
      used: Math.round(acuUsed * 100) / 100,
      total: Math.round(acuLimit * 100) / 100,
      unit: 'ACU',
      resetAt: isoFromRfc3339(st.planEnd),
    });
  }

  // Prepaid/overage money Devin reports beside the plan, when there is any.
  const overageMicros = num(st.overageBalanceMicros);
  if (overageMicros !== undefined && overageMicros > 0) {
    limits.push({
      label: 'Overage Balance',
      kind: 'balance',
      percent: 0,
      used: Math.round(overageMicros / 10_000) / 100,
      unit: '$',
    });
  }

  if (!limits.length) {
    return fail('GetUserStatus returned no quota, ACU or balance figures (plan shape changed?)');
  }

  const planLabel = tierName(u.teamsTier ?? info.teamsTier) || info.planName || undefined;

  return {
    ok: true,
    provider: 'devin',
    label: 'Devin',
    summary: {
      planLabel,
      planKey: planLabel,
      limits,
    },
  };
}
