import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderResult, UsageLimit } from './types';

const AUTH_PATH =
  process.env.GROK_AUTH_PATH || path.join(os.homedir(), '.grok', 'auth.json');
const BILLING_URL =
  process.env.GROK_BILLING_URL || 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SETTINGS_URL =
  process.env.GROK_SETTINGS_URL || 'https://cli-chat-proxy.grok.com/v1/settings';
const TOKEN_URL = process.env.GROK_TOKEN_URL || 'https://auth.x.ai/oauth2/token';
const TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS || 15000);
// Refresh a bit early so a request never rides on a borderline token.
const EXPIRY_SKEW_MS = 60_000;

/** Configured = the Grok CLI's auth store exists (`grok login` has run) and is a regular file. */
export function isConfigured(authPath: string = AUTH_PATH): boolean {
  try {
    return existsSync(authPath) && statSync(authPath).isFile();
  } catch {
    return false;
  }
}

/**
 * SuperGrok (xAI Grok) usage via the official Grok CLI billing endpoint.
 *
 * Reads OAuth token from ~/.grok/auth.json (populated by `grok login`).
 * Access tokens expire after ~6h; expired tokens are refreshed via the OIDC
 * refresh_token grant at auth.x.ai and the rotated pair is written back.
 * Calls the same `cli-chat-proxy.grok.com/v1/billing` that the CLI itself uses
 * to obtain the (now primarily weekly) shared usage pool + reset time.
 *
 * The response shape is undocumented and has evolved (monthly → weekly pool).
 * We are resilient to several observed shapes.
 */
export async function fetchSupergrokUsage(): Promise<ProviderResult> {
  // 1. Read auth file and extract a usable bearer token, refreshing the OIDC
  //    access token first if it has expired (refresh tokens rotate, so the new
  //    pair is written back to the auth file).
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return {
      ok: false,
      provider: 'supergrok',
      label: 'SuperGrok',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Fetch billing data (primary source for the shared weekly pool).
  //    One forced refresh + retry on 401/403: the access token can be rejected
  //    before our local expiry clock thinks it's dead.
  let billing: any;
  try {
    let resp = await fetchBilling(token);
    if (resp.status === 401 || resp.status === 403) {
      token = await getAccessToken({ force: true });
      resp = await fetchBilling(token);
    }
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        provider: 'supergrok',
        label: 'SuperGrok',
        error:
          'Auth token invalid or expired — run `grok login` again to refresh ~/.grok/auth.json',
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        provider: 'supergrok',
        label: 'SuperGrok',
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    billing = await resp.json();
  } catch (err) {
    return {
      ok: false,
      provider: 'supergrok',
      label: 'SuperGrok',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Try to also get plan name (best effort). The badge shows only the tier
  // word (e.g. "Heavy") — the card title already says SuperGrok.
  let planLabel: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const sresp = await fetch(SETTINGS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (sresp.ok) {
      const settings = await sresp.json();
      const tier =
        settings?.subscription_tier_display ||
        settings?.tier ||
        settings?.plan ||
        settings?.subscription ||
        settings?.user?.tier;
      if (typeof tier === 'string' && tier.length > 0) {
        // "SuperGrok Heavy" -> "Heavy"
        planLabel = tier.replace(/^super\s*grok\s*/i, '').trim() || undefined;
      }
    }
  } catch {
    /* non-fatal */
  }

  // 4. Normalize the usage into our shared shape (focus on Weekly pool).
  const limits: UsageLimit[] = [];

  const weekly = extractWeeklyLimit(billing);
  if (weekly) limits.push(weekly);

  // If the response also surfaces a short window (older 2h style) we can surface it as 5h for the card.
  const short = extractShortWindow(billing);
  if (short) limits.push(short);

  if (limits.length === 0) {
    // Still return ok with empty limits so the card can render gracefully (0%).
    // Many users will only see the Weekly bar populated.
  }

  return {
    ok: true,
    provider: 'supergrok',
    label: 'SuperGrok',
    summary: {
      planLabel,
      limits,
    },
    raw: { billing } as unknown,
  };
}

/**
 * Resolve a usable bearer token from ~/.grok/auth.json.
 * The Grok CLI writes OIDC entries scoped by issuer+client_id:
 *   { "https://auth.x.ai::<client_id>": { key, refresh_token, expires_at, oidc_client_id, ... } }
 * The access token in `key` expires after ~6h; when expired we run the
 * refresh_token grant and persist the rotated pair back to the file.
 * Never refresh unless that write can succeed — xAI refresh tokens rotate,
 * so a successful grant + failed write-back kills the grok CLI login.
 */
let inflightAccessToken: Promise<string> | null = null;

async function getAccessToken(opts: { force?: boolean } = {}): Promise<string> {
  if (inflightAccessToken) return inflightAccessToken;
  const run = resolveAccessToken(opts);
  inflightAccessToken = run;
  try {
    return await run;
  } finally {
    if (inflightAccessToken === run) inflightAccessToken = null;
  }
}

async function resolveAccessToken(opts: { force?: boolean }): Promise<string> {
  const fresh = await readAuthIfUsable(opts);
  if (fresh) return fresh;

  await assertAuthFileWritable(AUTH_PATH);

  // Same advisory lock the grok CLI uses (auth.json.lock + flock).
  // Held across the IdP call so we never double-spend a rotating refresh token.
  return withAuthLock(AUTH_PATH, async () => {
    const usable = await readAuthIfUsable(opts);
    if (usable) return usable;

    const { auth, entryName, entry } = await loadAuthEntry();
    if (!entry.refresh_token || !entry.oidc_client_id) {
      throw new Error(
        'Access token expired and no refresh_token available — run `grok login` again to refresh ~/.grok/auth.json',
      );
    }

    await assertAuthFileWritable(AUTH_PATH);

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: entry.refresh_token,
        client_id: entry.oidc_client_id,
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
        `Token refresh failed (HTTP ${resp.status}): ${data.error_description || 'unknown'} — run \`grok login\` again.`,
      );
    }

    auth[entryName] = {
      ...entry,
      key: data.access_token,
      refresh_token: data.refresh_token || entry.refresh_token,
      expires_at: new Date(Date.now() + (data.expires_in ?? 21600) * 1000).toISOString(),
    };
    await persistAuth(auth);
    return data.access_token;
  });
}

async function readAuthIfUsable(opts: { force?: boolean }): Promise<string | null> {
  const { auth, entry } = await loadAuthEntry();
  const expiresAt = Date.parse(entry.expires_at || '');
  const expired = !Number.isNaN(expiresAt) && expiresAt <= Date.now() + EXPIRY_SKEW_MS;
  if (!opts.force && !expired) return extractToken(auth);
  return null;
}

async function loadAuthEntry(): Promise<{ auth: any; entryName: string; entry: any }> {
  let auth: any;
  try {
    auth = JSON.parse(await fs.readFile(AUTH_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read auth file (${AUTH_PATH}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entryName = Object.keys(auth || {}).find(
    (k) => auth[k] && typeof auth[k] === 'object' && typeof auth[k].key === 'string',
  );
  if (!entryName) {
    throw new Error(
      `No access token found in ${AUTH_PATH}. Run \`grok login\` (or the Grok CLI) to authenticate.`,
    );
  }
  return { auth, entryName, entry: auth[entryName] };
}

/** Exclusive flock on sibling auth.json.lock — same file the grok CLI uses. */
async function withAuthLock<T>(authPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(path.dirname(authPath), 'auth.json.lock');
  await fs.writeFile(lockPath, '', { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
  const unlock = await tryFlockExclusive(lockPath);
  if (!unlock) {
    throw new Error(
      `Could not acquire grok auth.json.lock (${lockPath}) — another process is refreshing. Retry shortly; refusing to refresh to avoid invalidating grok login.`,
    );
  }
  try {
    return await fn();
  } finally {
    await unlock();
  }
}

async function tryFlockExclusive(lockPath: string): Promise<(() => Promise<void>) | null> {
  // Tests + macOS host: python fcntl. Docker Alpine: busybox flock.
  // Both helpers exit when stdin closes so unlock cannot orphan a 24h sleeper
  // that keeps auth.json.lock and blocks `grok` from refreshing.
  const py = await spawnLock(
    'python3',
    [
      '-c',
      'import fcntl, os, sys\n'
      + 'p=sys.argv[1]\n'
      + 'f=open(p,"a+")\n'
      + 'try:\n'
      + '  fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
      + 'except BlockingIOError:\n'
      + '  sys.exit(2)\n'
      + 'os.write(1, b"locked\\n")\n'
      + 'sys.stdin.read()\n',
      lockPath,
    ],
  );
  if (py) return py;
  return spawnLock('flock', ['-xn', lockPath, '-c', 'sh -c "echo locked; exec cat"']);
}

function spawnLock(cmd: string, args: string[]): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (unlock: (() => Promise<void>) | null) => {
      if (settled) return;
      settled = true;
      resolve(unlock);
    };
    const timer = setTimeout(() => {
      child.stdin?.end();
      child.kill('SIGTERM');
      done(null);
    }, 1500);
    child.stdout?.once('data', () => {
      clearTimeout(timer);
      done(
        () =>
          new Promise((res) => {
            const finish = () => res();
            child.once('exit', finish);
            child.stdin?.end();
            setTimeout(() => child.kill('SIGTERM'), 200);
          }),
      );
    });
    child.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

async function assertAuthFileWritable(filePath: string): Promise<void> {
  const probe = `${filePath}.write-probe`;
  try {
    const fh = await fs.open(filePath, 'r+');
    await fh.close();
    // persistAuth writes a sibling .tmp then renames; a file-only :ro bind
    // mount can leave the file itself looking writable while the directory is not.
    await fs.writeFile(probe, '', { encoding: 'utf8', flag: 'w' });
    await fs.unlink(probe);
  } catch {
    await fs.unlink(probe).catch(() => undefined);
    throw new Error(
      `Grok auth file is not writable (${filePath}). Remount ~/.grok read-write so rotated refresh tokens can be saved. Refusing to refresh (would invalidate grok login).`,
    );
  }
}

async function persistAuth(auth: unknown): Promise<void> {
  const tmp = `${AUTH_PATH}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, AUTH_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new Error(
      `Refreshed Grok token but failed to write ${AUTH_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }. Run \`grok login\` — the previous refresh token may already be invalid.`,
    );
  }
}

async function fetchBilling(token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(BILLING_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'quota-peek/1',
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/** Best-effort token extraction from the auth.json written by the official Grok CLI. */
function extractToken(auth: any): string {
  if (!auth || typeof auth !== 'object') return '';

  // Common patterns seen in the wild:
  // - { "https://accounts.x.ai/sign-in": { key: "..." , ... } }
  // - { "key": "..." } (top level in some wrappers)
  // - array or map of entries each having .key

  const candidates: any[] = [];

  // Direct key
  if (typeof auth.key === 'string' && auth.key.length > 20) candidates.push(auth.key);

  // OIDC-style scoped entries (object values)
  for (const val of Object.values(auth)) {
    if (val && typeof val === 'object') {
      if (typeof (val as any).key === 'string' && (val as any).key.length > 20) {
        candidates.push((val as any).key);
      }
      if (typeof (val as any).access_token === 'string') {
        candidates.push((val as any).access_token);
      }
      if (typeof (val as any).token === 'string') {
        candidates.push((val as any).token);
      }
    }
  }

  // If top level looks like an array of creds
  if (Array.isArray(auth)) {
    for (const e of auth) {
      if (e && typeof e === 'object') {
        if (typeof e.key === 'string' && e.key.length > 20) candidates.push(e.key);
        if (typeof e.access_token === 'string') candidates.push(e.access_token);
      }
    }
  }

  // Prefer JWT-looking strings (they usually start with eyJ...)
  const jwt = candidates.find((t) => typeof t === 'string' && t.startsWith('eyJ'));
  if (jwt) return jwt;

  return candidates.find((t) => typeof t === 'string' && t.length > 20) || '';
}

/** Extract the main (weekly) usage pool. */
function extractWeeklyLimit(b: any): UsageLimit | null {
  const c = b?.config || b?.data?.config || b || {};

  // Newer unified weekly pool often exposes usagePercent directly
  // (observed as `creditUsagePercent` in current unified billing responses).
  const directPct = typeof c.usagePercent === 'number' ? c.usagePercent : c.creditUsagePercent;
  if (typeof directPct === 'number') {
    const out: UsageLimit = {
      label: 'Weekly',
      kind: 'weekly',
      percent: clampPercent(directPct),
    };
    const end = c.currentPeriod?.end || c.billingPeriodEnd || c.periodEnd || c.resetAt;
    if (end) out.resetAt = normalizeDate(end);
    return out;
  }

  // productUsage array (seen in userscripts + some scrapers)
  const prod = Array.isArray(c.productUsage) ? c.productUsage : [];
  const weeklyProd = prod.find((p: any) => /weekly|pool|credit/i.test(String(p?.product || '')));
  if (weeklyProd && typeof weeklyProd.usagePercent === 'number') {
    const out: UsageLimit = {
      label: 'Weekly',
      kind: 'weekly',
      percent: clampPercent(weeklyProd.usagePercent),
    };
    if (weeklyProd.resetAt || c.currentPeriod?.end) {
      out.resetAt = normalizeDate(weeklyProd.resetAt || c.currentPeriod.end);
    }
    return out;
  }

  // Legacy / current "credits" style: used + monthlyLimit (or weekly equivalent)
  let used: number | undefined;
  let total: number | undefined;

  // .val style (cents or scaled)
  if (c.used && typeof c.used === 'object' && typeof c.used.val === 'number') {
    used = c.used.val;
  } else if (typeof c.used === 'number') {
    used = c.used;
  }

  const lim =
    c.monthlyLimit ||
    c.weeklyLimit ||
    c.limit ||
    c.poolLimit ||
    (c.config && (c.config.monthlyLimit || c.config.weeklyLimit));

  if (lim && typeof lim === 'object' && typeof lim.val === 'number') {
    total = lim.val;
  } else if (typeof lim === 'number') {
    total = lim;
  }

  if (typeof used === 'number' && typeof total === 'number' && total > 0) {
    // Many responses report in "cents" (val / 100 gives dollars, but ratio is the same)
    const pct = (used / total) * 100;
    const out: UsageLimit = {
      label: 'Weekly',
      kind: 'weekly',
      percent: clampPercent(pct),
    };
    const end = c.billingPeriodEnd || c.currentPeriod?.end || c.periodEnd;
    if (end) out.resetAt = normalizeDate(end);
    return out;
  }

  // Fallback: some responses put percent at top level of billing
  if (typeof b?.usagePercent === 'number') {
    const out: UsageLimit = { label: 'Weekly', kind: 'weekly', percent: clampPercent(b.usagePercent) };
    const end = b.currentPeriod?.end || b.billingPeriodEnd;
    if (end) out.resetAt = normalizeDate(end);
    return out;
  }

  // Handle the observed unified weekly billing response shape:
  // { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '...' }, ... } }
  // Even if no explicit 'used' / 'usagePercent' is present, we can surface the Weekly window + reset time.
  const period = c.currentPeriod || c;
  if (period && (period.type === 'USAGE_PERIOD_TYPE_WEEKLY' || /WEEKLY/i.test(String(period.type || '')))) {
    const end = period.end || c.billingPeriodEnd || c.currentPeriod?.end;
    return {
      label: 'Weekly',
      kind: 'weekly',
      percent: 0, // Consumption percent may be reported separately or not in this payload; bar at 0% but reset time is useful
      ...(end ? { resetAt: normalizeDate(end) } : {})
    };
  }

  return null;
}

/** Try to surface a short-horizon window if the backend still reports one (older behavior). */
function extractShortWindow(b: any): UsageLimit | null {
  const c = b?.config || b || {};
  // Heuristic: look for a 2h/5h style secondary counter.
  // If the API returns explicit short window fields in future, they will be picked up.
  // For now we only add it if we see something that looks like a distinct short reset.
  const shortUsed = c.shortUsed ?? c.rateLimitUsed ?? c.messagesUsed;
  const shortLimit = c.shortLimit ?? c.rateLimit ?? c.messagesLimit;
  if (typeof shortUsed === 'number' && typeof shortLimit === 'number' && shortLimit > 0) {
    const pct = (shortUsed / shortLimit) * 100;
    return {
      label: '5h Window',
      kind: '5h',
      percent: clampPercent(pct),
    };
  }
  return null;
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function normalizeDate(d: any): string | undefined {
  if (!d) return undefined;
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return undefined;
    return dt.toISOString();
  } catch {
    return undefined;
  }
}
