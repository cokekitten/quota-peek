import { fetchClaudeUsage } from './claude.js';
import { fetchCodexUsage } from './codex.js';
import { fetchGlmUsage } from './glm.js';

const providers = [
  { key: 'claude', fn: fetchClaudeUsage },
  { key: 'codex', fn: fetchCodexUsage },
  { key: 'glm', fn: fetchGlmUsage },
];

/** Run every provider in parallel. Failures are isolated (ok:false), never thrown. */
export async function fetchAllUsage() {
  const settled = await Promise.allSettled(providers.map((p) => p.fn()));
  const out = {};
  providers.forEach((p, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      out[p.key] = r.value;
    } else {
      out[p.key] = {
        ok: false,
        provider: p.key,
        error: r.reason?.message || String(r.reason),
      };
    }
  });
  return out;
}

export async function fetchOneUsage(key) {
  const p = providers.find((x) => x.key === key);
  if (!p) throw new Error(`Unknown provider: ${key}`);
  return p.fn();
}

export const PROVIDER_KEYS = providers.map((p) => p.key);
