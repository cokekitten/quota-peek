/**
 * Two in-process caches in front of the provider registry.
 *
 * 1. **Dedupe cache** (60s, successes only) — the poller and a page load that
 *    overlap must not call the same provider twice: several of them rate-limit
 *    hard (Anthropic's 5-minute window, Kimi's ~15-minute OAuth tokens). A
 *    failure is never cached here, or a transient outage would turn into a
 *    minute of offline cards.
 *
 * 2. **Latest result** (no TTL on write, the *reader* decides) — what the
 *    sampler last saw, success or failure. Page requests are answered from
 *    here instead of calling upstream again, so opening the dashboard no
 *    longer doubles the API traffic that causes the rate limiting in the
 *    first place. A failure is kept: a fresh failure is the honest answer
 *    (offline card), and it is only served while it is young.
 *
 * Both are per-process and in memory: a restart falls back to live fetches
 * until the first poll lands, which is the desired behaviour anyway.
 */

import { fetchOneUsage } from '../providers';
import type { ProviderKey, ProviderResult } from '../providers/types';

const DEFAULT_TTL_MS = 60_000;

export function cacheTtlMs(): number {
  const n = Number(process.env.QP_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

interface Entry {
  result: ProviderResult;
  at: number;
}

const cache = new Map<ProviderKey, Entry>();
const latest = new Map<ProviderKey, Entry>();
const inflight = new Map<ProviderKey, Promise<Entry>>();

/** Last successful result for `provider` if it is still inside the TTL. */
export function peek(provider: ProviderKey, now: number = Date.now()): ProviderResult | null {
  const hit = cache.get(provider);
  if (!hit) return null;
  if (now - hit.at > cacheTtlMs()) {
    cache.delete(provider);
    return null;
  }
  return hit.result;
}

/** Store a result: the dedupe cache only takes successes, `latest` takes both. */
export function prime(provider: ProviderKey, result: ProviderResult, now: number = Date.now()): void {
  latest.set(provider, { result, at: now });
  if (result.ok) cache.set(provider, { result, at: now });
  else cache.delete(provider);
}

/** The most recent read for `provider`, whatever it was. */
export function latestResult(provider: ProviderKey): Entry | null {
  return latest.get(provider) ?? null;
}

export type UsageFetcher = (provider: ProviderKey) => Promise<ProviderResult>;

/** The real fetcher: same short-circuits (unconfigured, unknown key) as the API route. */
export const registryFetcher: UsageFetcher = (provider) => fetchOneUsage(provider);

export type LiveSource = 'cache' | 'fetch' | 'joined';

export interface LiveResult {
  result: ProviderResult;
  /** When the value was obtained upstream. */
  at: number;
  /**
   * Whether *this* call is the one that produced it. Only `'fetch'` may write
   * a history sample — recording a value another caller already recorded would
   * put duplicate readings (and duplicate log rows) in the timeline.
   */
  source: LiveSource;
}

/**
 * Fetch usage, reusing a fresh cached result and collapsing concurrent callers
 * for the same provider onto one upstream request.
 */
export async function liveUsage(
  provider: ProviderKey,
  fetchUsage: UsageFetcher = registryFetcher,
  now: number = Date.now(),
  opts: { fresh?: boolean } = {},
): Promise<LiveResult> {
  // `fresh` is for the sampler: its whole job is to read the provider, so it
  // must not be served a cached reading just because the previous round was
  // less than a TTL ago (which it always is at a 60s sampling interval).
  const hit = opts.fresh ? undefined : cache.get(provider);
  if (hit && now - hit.at <= cacheTtlMs()) {
    return { result: hit.result, at: hit.at, source: 'cache' };
  }
  if (hit) cache.delete(provider);
  const pending = inflight.get(provider);
  if (pending) {
    const entry = await pending;
    return { ...entry, source: 'joined' };
  }
  const p = fetchUsage(provider)
    .then((result) => {
      const at = Date.now();
      prime(provider, result, at);
      return { result, at };
    })
    .finally(() => {
      inflight.delete(provider);
    });
  inflight.set(provider, p);
  const entry = await p;
  return { ...entry, source: 'fetch' };
}

/** Test seam. */
export function clearCache(): void {
  cache.clear();
  latest.clear();
  inflight.clear();
}
