import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderResult } from './types';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 30000);

/**
 * Claude Code usage via the `claude` CLI in print mode.
 * Runs: claude -p "/usage" --output-format json
 */
export async function fetchClaudeUsage(): Promise<ProviderResult> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', '/usage', '--output-format', 'json'],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    let parsed: unknown = null;
    let text = stdout.trim();
    try {
      parsed = JSON.parse(text);
      const result = (parsed as { result?: unknown }).result;
      text = typeof result === 'string' ? result : text;
    } catch {
      // stdout wasn't JSON — treat as plain text.
    }

    return summarize(text, parsed);
  } catch (err) {
    return {
      ok: false,
      provider: 'claude',
      label: 'Claude Code',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const LABELS: Record<string, string> = {
  current_session: 'Session',
  current_week_all_models: 'Week · all models',
  current_week_sonnet_only: 'Week · Sonnet only',
};

/** Pull every "label: NN%" out of the usage text. */
function summarize(text: string, raw: unknown): ProviderResult {
  const metrics: Record<string, number> = {};
  // Allow parentheses so labels like "Current week (all models)" match.
  const re = /([A-Za-z][A-Za-z0-9 /()_-]*?):\s*(\d+(?:\.\d+)?)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = normalizeKey(m[1]);
    if (key) metrics[key] = Number(m[2]);
  }

  const limits = Object.entries(metrics).map(([k, v]) => ({
    label: LABELS[k] || prettify(k),
    kind: k,
    percent: v,
  }));

  return {
    ok: true,
    provider: 'claude',
    label: 'Claude Code',
    summary: { planLabel: 'Claude Code', limits },
    text,
    raw,
  };
}

/** "Current week (all models)" -> "current_week_all_models" */
function normalizeKey(rawKey: string): string {
  return rawKey
    .toLowerCase()
    .replace(/\(([^)]*)\)/g, '_$1') // (all models) -> _all models
    .replace(/[^a-z0-9]+/g, '_') // non-alnum -> _
    .replace(/^_+|_+$/g, '');
}

function prettify(key: string): string {
  return key.replace(/_/g, ' ').replace(/(^|\s)\S/g, (mm) => mm.toUpperCase());
}
