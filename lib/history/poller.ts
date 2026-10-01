/**
 * Background sampler: fetch every configured provider on a fixed interval and
 * write the result to the history store, so usage keeps a timeline even when
 * nobody has the dashboard open.
 *
 * Design notes:
 *  - One timer per process, guarded on globalThis — `instrumentation.ts` can be
 *    re-evaluated by the dev server (HMR) and a duplicate poller would double
 *    every API call and every sample.
 *  - Providers run sequentially. Parallel fan-out is faster but these are
 *    rate-limited APIs on a home server; being a few seconds late is free.
 *  - A provider with no credentials is skipped, not sampled: its card is
 *    hidden anyway, and a "not_configured" row every 5 minutes is noise.
 *  - A failed provider is recorded (so the timeline can distinguish "no
 *    spending" from "no data") and never retried inside the same round.
 */

import os from 'node:os';
import { acquireLease, DEFAULT_LEASE_MS, leaseState, ownerId, releaseLease } from './db';
import { PROVIDERS, PROVIDER_KEYS } from '../providers';
import type { ProviderKey, ProviderResult } from '../providers/types';
import { extractSample } from './extract';
import { liveUsage, registryFetcher, type UsageFetcher } from './liveCache';
import { pollIntervalMs } from './series';
import { prune, record, retentionDays } from './store';

export const POLL_ENABLED = process.env.QP_POLL !== '0';

export interface PollProviderOutcome {
  provider: ProviderKey;
  ok: boolean;
  errKind: string | null;
  rows: number;
  skipped?: 'not_configured' | 'store';
  /** Why the sample could not be persisted (store failures only). */
  storeError?: string;
  ms: number;
}

export interface PollSummary {
  at: number;
  tookMs: number;
  providers: PollProviderOutcome[];
  pruned: boolean;
  /** Set when the round deliberately did not sample. */
  skipped?: SkipReason;
}

/** Why a round did not run (or did). */
export type SkipReason = 'lease_held_elsewhere' | 'already_running' | 'disabled';

export interface PollOptions {
  fetchUsage?: UsageFetcher;
  /**
   * Only this owner may sample. Defaults to this process; the lease in the
   * database is what actually arbitrates between replicas.
   */
  owner?: string;
  /** Lease lifetime for a round. */
  leaseMs?: number;
  /** Skip the lease entirely (single-process installs, tests). */
  noLease?: boolean;
  /** Defaults to every provider that has credentials. */
  keys?: readonly ProviderKey[];
  now?: number;
  /** Run the retention prune at the end of the round. */
  prune?: boolean;
  /** Ignore the isConfigured() check (tests inject their own fetcher). */
  assumeConfigured?: boolean;
}

/** Provider keys worth polling: anything the dashboard would show a card for. */
export function pollableKeys(): ProviderKey[] {
  return PROVIDER_KEYS.filter((k) => {
    try {
      return PROVIDERS[k].isConfigured();
    } catch {
      return false;
    }
  });
}

/**
 * One full round. Never throws: a broken provider is an outcome, not an error.
 *
 * Takes the sampling lease first. With several replicas sharing one database
 * that is what keeps the upstream calls at one round's worth instead of N.
 */
export async function pollOnce(opts: PollOptions = {}): Promise<PollSummary> {
  const started = opts.now ?? Date.now();
  if (!opts.noLease) {
    const owner = opts.owner ?? ownerId();
    if (!acquireLease(owner, opts.leaseMs ?? leaseTtlMs(), started)) {
      return { at: started, tookMs: 0, providers: [], pruned: false, skipped: 'lease_held_elsewhere' };
    }
  }
  const fetchUsage = opts.fetchUsage ?? registryFetcher;
  const keys =
    opts.keys ??
    (opts.assumeConfigured ? [...PROVIDER_KEYS] : pollableKeys());
  const providers: PollProviderOutcome[] = [];
  for (const provider of keys) {
    const t0 = Date.now();
    try {
      // `fresh` — the sampler always reads the provider for real, but it still
      // primes (and joins) the shared caches so a page load landing right
      // after a round reuses that value instead of calling upstream again.
      const live = await liveUsage(provider, fetchUsage, undefined, { fresh: true });
      const result: ProviderResult = live.result;
      const sample = extractSample(result, 'poll', live.at);
      // Only the caller that actually fetched writes history — a reused
      // reading is already in the timeline.
      const stored = live.source === 'fetch' ? record(sample, sample.ts) : null;
      providers.push({
        provider,
        ok: result.ok,
        errKind: sample.errKind,
        rows: sample.rows.length,
        ...(stored?.skipped ? { skipped: 'store' as const, storeError: stored.skipped } : {}),
        ms: Date.now() - t0,
      });
    } catch {
      // The fetcher itself threw (shouldn't — providers return failures as data).
      providers.push({
        provider,
        ok: false,
        errKind: 'error',
        rows: 0,
        skipped: 'store',
        ms: Date.now() - t0,
      });
    }
  }
  let pruned = false;
  if (opts.prune) {
    prune(retentionDays());
    pruned = true;
  }
  return { at: started, tookMs: Date.now() - started, providers, pruned };
}

/** Lease lifetime: long enough to cover a slow round plus a missed tick. */
export function leaseTtlMs(intervalMs: number = pollIntervalMs()): number {
  const n = Number(process.env.QP_POLL_LEASE_MS);
  return Number.isFinite(n) && n > 0 ? n : Math.max(DEFAULT_LEASE_MS, 2 * intervalMs);
}

const REGISTRY = Symbol.for('quota-peek.poller');

interface PollerState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  last: PollSummary | null;
  rounds: number;
  /** When retention last ran, so it happens daily instead of never. */
  lastPruneAt: number;
}

const PRUNE_INTERVAL_MS = 24 * 3600e3;

function state(): PollerState {
  const g = globalThis as unknown as Record<symbol, PollerState | undefined>;
  if (!g[REGISTRY]) {
    g[REGISTRY] = { timer: null, running: false, last: null, rounds: 0, lastPruneAt: 0 };
  }
  return g[REGISTRY] as PollerState;
}

/** True while a round is in flight — the timer skips instead of stacking. */
export function isPolling(): boolean {
  return state().running;
}

export function lastPoll(): PollSummary | null {
  return state().last;
}

/** Run a round unless one is still going. Returns null when it re-entered. */
export async function pollIfIdle(opts: PollOptions = {}): Promise<PollSummary | null> {
  const s = state();
  if (s.running) return null;
  s.running = true;
  try {
    // Retention runs once a day: the first round after boot, then every 24h.
    const now = opts.now ?? Date.now();
    const doPrune = opts.prune ?? now - s.lastPruneAt >= PRUNE_INTERVAL_MS;
    const summary = await pollOnce({ ...opts, prune: doPrune });
    if (summary.skipped) return summary; // another replica owns sampling
    if (doPrune) s.lastPruneAt = now;
    s.last = summary;
    s.rounds += 1;
    return summary;
  } finally {
    s.running = false;
  }
}

export interface StartOptions extends PollOptions {
  /** Override the interval (tests). */
  intervalMs?: number;
  /** First round after this delay (tests use 0). */
  initialDelayMs?: number;
}

/**
 * Idempotent: calling it twice never yields two timers. The first round is
 * delayed a little so a cold start doesn't fire every provider at once.
 */
export function startPoller(opts: StartOptions = {}): void {
  const s = state();
  if (s.timer) return;
  const { intervalMs, initialDelayMs, ...round } = opts;
  const interval = Math.max(1000, intervalMs ?? pollIntervalMs());
  const owner = round.owner ?? ownerId();
  const initial = initialDelayMs ?? Math.round(Math.random() * Math.min(interval, 30_000));
  const tick = () => {
    void pollIfIdle({ ...round, owner }).then((summary) => {
      if (!summary) return;
      if (summary.skipped === 'lease_held_elsewhere') {
        noteLeaseHolder();
        return;
      }
      const bad = summary.providers.filter((p) => !p.ok).map((p) => p.provider);
      // One line per round: what the poll did, and who failed. No secrets.
      console.log(
        `[quota-peek] poll ${summary.providers.length} provider(s) in ${summary.tookMs}ms` +
          (bad.length ? ` · failed: ${bad.join(', ')}` : ''),
      );
    });
  };
  if (initial > 0) {
    setTimeout(tick, initial).unref?.();
  } else {
    tick();
  }
  s.timer = setInterval(tick, interval);
  s.timer.unref?.();
}

export function stopPoller(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  // Hand the lease back so another replica can take over immediately instead
  // of waiting out the TTL.
  releaseLease();
}

/** Say once per hour who else is sampling, instead of every tick. */
let leaseNoteAt = 0;
function noteLeaseHolder(): void {
  const now = Date.now();
  if (now - leaseNoteAt < 3600e3) return;
  leaseNoteAt = now;
  const lease = leaseState(now);
  console.log(
    `[quota-peek] another instance is sampling (${lease?.owner ?? 'unknown'}) — this one stays idle`,
  );
}

/** Who currently holds the sampling lease, for the status endpoint. */
export function currentLease(): ReturnType<typeof leaseState> {
  return leaseState();
}

/** Test seam: drop the singleton entirely. */
export function resetPoller(): void {
  stopPoller();
  const g = globalThis as unknown as Record<symbol, PollerState | undefined>;
  delete g[REGISTRY];
}

/**
 * Start sampling if sampling is enabled. Idempotent — safe to call from every
 * request path (and from the boot handoff) without stacking timers.
 */
export function ensurePoller(): void {
  if (!POLL_ENABLED) return;
  startPoller();
}

export { liveUsage };
