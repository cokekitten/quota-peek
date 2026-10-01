/**
 * Normalize a provider fetch result into history rows.
 *
 * The history store is schema-agnostic on purpose: it never imports the
 * provider registry, so a provider that renames a window or drops a field
 * only has to keep the documented UsageLimit shape, and a new provider is
 * recorded with zero changes here.
 *
 * Row identity is (scope, kind):
 *   - scope `merged` — the card's default view (the single account's own view
 *     when a provider has just one, the cross-account merge when it has more).
 *   - scope `<account key>` — a per-account view from summary.accounts, so
 *     "Kimi account 2" keeps its own curve even when the merged Σ moves.
 */

import { MERGED, type SampleInput, type SampleRowInput } from './db';
import type { ProviderResult, UsageLimit } from '../providers/types';

/** Provider errors can carry a response body; the history only needs a hint. */
const MAX_ERR_CHARS = 500;

export type ErrKind = 'not_configured' | 'error';

function finite(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function resetAtMs(resetAt: string | undefined): number | null {
  if (!resetAt) return null;
  const t = new Date(resetAt).getTime();
  return Number.isFinite(t) ? t : null;
}

function toRow(scope: string, limit: UsageLimit): SampleRowInput {
  return {
    scope,
    kind: limit.kind,
    label: limit.label ?? null,
    percent: finite(limit.percent),
    used: finite(limit.used),
    total: finite(limit.total),
    unit: limit.unit ?? null,
    resetAt: resetAtMs(limit.resetAt),
    estimated: !!limit.estimated,
  };
}

/** A provider's rows in a stable order: merged first, then accounts by key. */
function collectRows(result: ProviderResult): SampleRowInput[] {
  if (!result.ok) return [];
  const summary = result.summary;
  if (!summary) return [];
  const rows = summary.limits.map((l) => toRow(MERGED, l));
  for (const account of summary.accounts ?? []) {
    if (!account.ok) continue; // a dead account contributes a sample error, not rows
    for (const limit of account.limits) rows.push(toRow(account.key, limit));
  }
  return rows;
}

export interface AccountPlanLabel {
  key: string;
  label: string;
}

export interface ExtractedSample extends SampleInput {
  /** Sample timestamp (epoch ms) — pass it to record() to keep them aligned. */
  ts: number;
  rows: SampleRowInput[];
  errKind: ErrKind | null;
  /** Account keys that failed inside an otherwise-successful read. */
  errScopes: string[];
  /** Per-account plan labels, for cards that merge several memberships. */
  planLabels: AccountPlanLabel[];
  /** True when at least one row carries a per-window percentage. */
  hasPercent: boolean;
  /** True when at least one row carries an absolute used/total pair. */
  hasAbsolute: boolean;
  /** Row kinds seen, for stats. */
  kinds: string[];
}

/** Build the sample to persist for one provider fetch. */
export function extractSample(
  result: ProviderResult,
  source: string,
  ts: number = Date.now(),
): ExtractedSample {
  const rows = collectRows(result);
  const errKind: ErrKind | null = !result.ok
    ? result.notConfigured
      ? 'not_configured'
      : 'error'
    : null;
  // A merged card that silently lost a member looks like a usage drop on the
  // timeline, so the failed keys are recorded with the sample itself.
  const accounts = result.summary?.accounts ?? [];
  const errScopes = errKind ? [] : accounts.filter((a) => !a.ok).map((a) => a.key);
  const planLabels = accounts
    .filter((a) => a.ok && a.planLabel)
    .map((a) => ({ key: a.key, label: a.planLabel as string }));
  return {
    provider: result.provider,
    source,
    ts,
    ok: result.ok,
    errKind,
    errText: result.error ? result.error.slice(0, MAX_ERR_CHARS) : null,
    planLabel: result.summary?.planLabel ?? null,
    partial: !!result.summary?.partial || errScopes.length > 0,
    stale: !!result.stale,
    rows,
    errScopes,
    planLabels,
    hasPercent: rows.some((r) => r.percent !== null),
    hasAbsolute: rows.some((r) => r.used !== null || r.total !== null),
    kinds: [...new Set(rows.map((r) => r.kind))],
  };
}
