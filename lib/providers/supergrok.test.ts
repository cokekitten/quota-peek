import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTRY = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const OLD_REFRESH = 'old-refresh-token-must-not-be-burned';
const NEW_ACCESS = 'new-access-token-xxxxxxxxxxxxxxxxxxxx';
const NEW_REFRESH = 'new-refresh-token-after-rotate';

const ENV_KEYS = [
  'GROK_AUTH_PATH',
  'GROK_BILLING_URL',
  'GROK_SETTINGS_URL',
  'GROK_TOKEN_URL',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function billingOk() {
  return json(200, {
    config: {
      creditUsagePercent: 12,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-20T00:00:00Z' },
    },
  });
}

async function writeAuth(
  dir: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const authPath = path.join(dir, 'auth.json');
  const auth = {
    [ENTRY]: {
      key: 'old-access-token-xxxxxxxxxxxxxxxxxxxx',
      refresh_token: OLD_REFRESH,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      oidc_client_id: CLIENT_ID,
      ...overrides,
    },
  };
  await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return authPath;
}

async function loadProvider() {
  vi.resetModules();
  return import('./supergrok');
}

beforeAllEnv();

function beforeAllEnv() {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setupAuth(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quota-peek-grok-'));
  tempDirs.push(dir);
  const authPath = await writeAuth(dir, overrides);
  process.env.GROK_AUTH_PATH = authPath;
  return { dir, authPath };
}

describe('fetchSupergrokUsage token persistence', () => {
  it('does not call the token endpoint when the auth file is not writable', async () => {
    const { authPath } = await setupAuth();
    await chmod(authPath, 0o444);

    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchSupergrokUsage } = await loadProvider();
    const result = await fetchSupergrokUsage();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not writable/i);
    expect(fetchMock).not.toHaveBeenCalled();

    const saved = JSON.parse(await readFile(authPath, 'utf8'));
    expect(saved[ENTRY].refresh_token).toBe(OLD_REFRESH);
  });

  it('does not refresh when the auth directory is not writable', async () => {
    const { dir, authPath } = await setupAuth();
    await chmod(dir, 0o555);
    try {
      const fetchMock = vi.fn(async () => {
        throw new Error('fetch should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);

      const { fetchSupergrokUsage } = await loadProvider();
      const result = await fetchSupergrokUsage();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not writable/i);
      expect(fetchMock).not.toHaveBeenCalled();

      const saved = JSON.parse(await readFile(authPath, 'utf8'));
      expect(saved[ENTRY].refresh_token).toBe(OLD_REFRESH);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('persists the rotated refresh token after a successful refresh', async () => {
    const { authPath } = await setupAuth();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/token')) {
          return json(200, {
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            expires_in: 21600,
          });
        }
        if (url.includes('/v1/billing')) return billingOk();
        if (url.includes('/v1/settings')) return json(200, { subscription_tier_display: 'Heavy' });
        throw new Error(`unexpected ${url}`);
      }),
    );

    const { fetchSupergrokUsage } = await loadProvider();
    const result = await fetchSupergrokUsage();

    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(authPath, 'utf8'));
    expect(saved[ENTRY].key).toBe(NEW_ACCESS);
    expect(saved[ENTRY].refresh_token).toBe(NEW_REFRESH);
  });

  it('retries billing once after 401 by forcing a refresh', async () => {
    const { authPath } = await setupAuth({
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    let billingCalls = 0;
    let tokenCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/token')) {
          tokenCalls += 1;
          return json(200, {
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            expires_in: 21600,
          });
        }
        if (url.includes('/v1/billing')) {
          billingCalls += 1;
          if (billingCalls === 1) return new Response('unauthorized', { status: 401 });
          return billingOk();
        }
        if (url.includes('/v1/settings')) return json(200, {});
        throw new Error(`unexpected ${url}`);
      }),
    );

    const { fetchSupergrokUsage } = await loadProvider();
    const result = await fetchSupergrokUsage();

    expect(result.ok).toBe(true);
    expect(tokenCalls).toBe(1);
    expect(billingCalls).toBe(2);
    const saved = JSON.parse(await readFile(authPath, 'utf8'));
    expect(saved[ENTRY].refresh_token).toBe(NEW_REFRESH);
  });

  it('collapses concurrent expired-token fetches into one refresh', async () => {
    await setupAuth();

    let tokenCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/token')) {
          tokenCalls += 1;
          await new Promise((r) => setTimeout(r, 40));
          return json(200, {
            access_token: `${NEW_ACCESS}-${tokenCalls}`,
            refresh_token: `${NEW_REFRESH}-${tokenCalls}`,
            expires_in: 21600,
          });
        }
        if (url.includes('/v1/billing')) return billingOk();
        if (url.includes('/v1/settings')) return json(200, {});
        throw new Error(`unexpected ${url}`);
      }),
    );

    const { fetchSupergrokUsage } = await loadProvider();
    const [a, b] = await Promise.all([fetchSupergrokUsage(), fetchSupergrokUsage()]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(tokenCalls).toBe(1);
  });

  it('does not refresh while another process holds auth.json.lock', async () => {
    const { dir, authPath } = await setupAuth();
    const lockPath = path.join(dir, 'auth.json.lock');
    const holder = spawn(
      'python3',
      [
        '-c',
        'import fcntl, time, sys; f=open(sys.argv[1],"a+"); fcntl.flock(f, fcntl.LOCK_EX); sys.stdout.write("locked\\n"); sys.stdout.flush(); time.sleep(30)',
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock holder did not start')), 3000);
      holder.stdout?.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      holder.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}`));
      });
    });
    try {
      const fetchMock = vi.fn(async () => {
        throw new Error('fetch should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);

      const { fetchSupergrokUsage } = await loadProvider();
      const result = await fetchSupergrokUsage();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/lock/i);
      expect(fetchMock).not.toHaveBeenCalled();

      const saved = JSON.parse(await readFile(authPath, 'utf8'));
      expect(saved[ENTRY].refresh_token).toBe(OLD_REFRESH);
    } finally {
      holder.kill('SIGTERM');
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    }
  });

  it('releases auth.json.lock after a successful refresh so grok CLI can continue', async () => {
    const { dir, authPath } = await setupAuth();
    const lockPath = path.join(dir, 'auth.json.lock');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth2/token')) {
          return json(200, {
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            expires_in: 21600,
          });
        }
        if (url.includes('/v1/billing')) return billingOk();
        if (url.includes('/v1/settings')) return json(200, {});
        throw new Error(`unexpected ${url}`);
      }),
    );

    const { fetchSupergrokUsage } = await loadProvider();
    const result = await fetchSupergrokUsage();
    expect(result.ok).toBe(true);

    const checker = spawn(
      'python3',
      [
        '-c',
        'import fcntl, sys; f=open(sys.argv[1],"a+");\n'
        + 'try:\n'
        + '  fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
        + 'except BlockingIOError:\n'
        + '  sys.exit(3)\n',
        lockPath,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const code = await new Promise<number | null>((resolve) => {
      checker.once('exit', (c) => resolve(c));
    });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(authPath, 'utf8'));
    expect(saved[ENTRY].refresh_token).toBe(NEW_REFRESH);
  });
});
