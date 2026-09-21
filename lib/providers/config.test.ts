import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_KEYS, configuredMap, fetchOneUsage } from './index';
import { isConfigured as claudeConfigured } from './claude';
import { isConfigured as codexConfigured } from './codex';
import { isConfigured as supergrokConfigured } from './supergrok';
import { isConfigured as glmConfigured } from './glm';
import { isConfigured as minimaxConfigured } from './minimax';
import { isConfigured as kimiConfigured } from './kimi';
import { isConfigured as volcengineConfigured } from './volcengine';
import { isConfigured as deepseekConfigured } from './deepseek';
import { isConfigured as mimoConfigured } from './mimo';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Env vars the probes look at, so tests can start from a clean slate. */
const ENV_VARS = [
  'GLM_API_KEY',
  'GLM_BASE_URL',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_PLAN_LABEL',
  'KIMI_API_KEY',
  'KIMI_CREDENTIALS_PATH',
  'VOLC_ACCESS_KEY',
  'VOLC_SECRET_KEY',
  'VOLC_PLAN_LABEL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_TOKEN',
  'DEEPSEEK_BASE_URL',
  'MIMO_COOKIE',
  'MIMO_BASE_URL',
];

function setEnv(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Clear every provider credential var (all indexed accounts). */
function clearProviderEnv() {
  for (const v of ENV_VARS) {
    for (let n = 1; n <= 9; n++) setEnv(n === 1 ? v : `${v}_${n}`);
  }
}

const saved = new Map<string, string | undefined>(
  ENV_VARS.map((v) => [v, process.env[v]]),
);

afterEach(() => {
  clearProviderEnv();
  // Put back whatever this process actually had, so we never leak state.
  for (const [k, v] of saved) setEnv(k, v);
});

describe('key-based provider probes', () => {
  it('report unconfigured with no keys at all', () => {
    clearProviderEnv();
    // Kimi falls back to the Kimi Code CLI's own credential file, which exists
    // on machines that use that CLI — pin it away to test "nothing configured".
    setEnv('KIMI_CREDENTIALS_PATH', '/tmp/quota-peek-definitely-missing.json');
    expect(glmConfigured()).toBe(false);
    expect(minimaxConfigured()).toBe(false);
    expect(kimiConfigured()).toBe(false);
    expect(volcengineConfigured()).toBe(false);
    expect(deepseekConfigured()).toBe(false);
    expect(mimoConfigured()).toBe(false);
  });

  it('report configured from the unsuffixed key', () => {
    clearProviderEnv();
    setEnv('GLM_API_KEY', 'k1');
    setEnv('MINIMAX_API_KEY', 'k1');
    setEnv('VOLC_ACCESS_KEY', 'ak');
    setEnv('VOLC_SECRET_KEY', 'sk');
    expect(glmConfigured()).toBe(true);
    expect(minimaxConfigured()).toBe(true);
    expect(volcengineConfigured()).toBe(true);
    setEnv('DEEPSEEK_API_KEY', 'sk-ds');
    setEnv('MIMO_COOKIE', 'api-platform_serviceToken=x');
    expect(deepseekConfigured()).toBe(true);
    expect(mimoConfigured()).toBe(true);
  });

  it('count a suffixed key alone (account 1 absent, gaps allowed)', () => {
    clearProviderEnv();
    setEnv('GLM_API_KEY_3', 'k3');
    setEnv('MINIMAX_API_KEY_2', 'k2');
    expect(glmConfigured()).toBe(true);
    expect(minimaxConfigured()).toBe(true);
  });

  it('require both halves of the Volcengine AK/SK pair', () => {
    clearProviderEnv();
    setEnv('VOLC_ACCESS_KEY', 'ak');
    expect(volcengineConfigured()).toBe(false);
    setEnv('VOLC_SECRET_KEY', 'sk');
    expect(volcengineConfigured()).toBe(true);
  });

  it('treat auxiliary vars (base URL, plan label) as no credentials', () => {
    clearProviderEnv();
    setEnv('GLM_BASE_URL', 'https://example.invalid');
    setEnv('MINIMAX_PLAN_LABEL', 'Pro');
    setEnv('VOLC_PLAN_LABEL', 'Pro');
    expect(glmConfigured()).toBe(false);
    expect(minimaxConfigured()).toBe(false);
    expect(volcengineConfigured()).toBe(false);
    expect(deepseekConfigured()).toBe(false);
    expect(mimoConfigured()).toBe(false);
  });

  it('count a DeepSeek token alone as an account (spend without balance)', () => {
    clearProviderEnv();
    setEnv('DEEPSEEK_TOKEN_2', 'web-token');
    expect(deepseekConfigured()).toBe(true);
  });

  it('accept a Kimi API key or an existing credentials file', () => {
    clearProviderEnv();
    setEnv('KIMI_API_KEY_2', 'sk-2');
    expect(kimiConfigured()).toBe(true);

    clearProviderEnv();
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-kimi-'));
    const file = path.join(dir, 'kimi-code.json');
    writeFileSync(file, JSON.stringify({ access_token: 'x' }));
    setEnv('KIMI_CREDENTIALS_PATH', file);
    expect(kimiConfigured()).toBe(true);

    // A path that points nowhere is not "configured".
    setEnv('KIMI_CREDENTIALS_PATH', path.join(dir, 'missing.json'));
    expect(kimiConfigured()).toBe(false);
  });
});

describe('credential-file provider probes', () => {
  it('are unconfigured for a missing file and configured for a present one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qp-creds-'));
    const missing = path.join(dir, 'nope.json');
    const present = path.join(dir, 'here.json');
    writeFileSync(present, '{}');
    expect(existsSync(missing)).toBe(false);

    for (const probe of [claudeConfigured, codexConfigured, supergrokConfigured]) {
      expect(probe(missing)).toBe(false);
      expect(probe(present)).toBe(true);
    }
  });
});

describe('configuredMap', () => {
  it('covers every provider key with a boolean', () => {
    const map = configuredMap();
    expect(Object.keys(map).sort()).toEqual([...PROVIDER_KEYS].sort());
    for (const key of PROVIDER_KEYS) expect(typeof map[key]).toBe('boolean');
  });

  it('flips key-based providers with their env vars', () => {
    clearProviderEnv();
    expect(configuredMap().glm).toBe(false);
    setEnv('GLM_API_KEY', 'k1');
    expect(configuredMap().glm).toBe(true);
  });
});

describe('fetchOneUsage short-circuit', () => {
  it('labels a keyless provider notConfigured without calling out', async () => {
    clearProviderEnv();
    const result = await fetchOneUsage('glm');
    expect(result).toMatchObject({
      ok: false,
      provider: 'glm',
      notConfigured: true,
    });
    // The hint names the var to set, which is what the revealed card shows.
    expect(result.error).toContain('GLM_API_KEY');
  });

  it('never marks a configured provider notConfigured', async () => {
    // A bogus base URL makes the fetch fail; that must stay a normal offline
    // error, otherwise real breakage would be hidden along with missing keys.
    clearProviderEnv();
    setEnv('GLM_API_KEY', 'not-a-real-key');
    setEnv('GLM_BASE_URL', 'https://quota-peek.test.invalid');
    const result = await fetchOneUsage('glm');
    expect(result.ok).toBe(false);
    expect(result.notConfigured).toBeUndefined();
  });
});
