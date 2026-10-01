/**
 * One short-lived cache in front of the provider registry, shared by the
 * background poller and the dashboard's own requests.
 *
 * Why it exists: the poller and a browser hitting "Refresh" at the same moment
 * would otherwise call the same provider twice, and several of them rate-limit
 * hard (Anthropic's 5-minute window, Kimi's ~15-minute OAuth tokens). A 60s
 * reuse window is invisible on a dashboard and removes the double hit.
 *
 * It is deliberately not a "serve stale forever" cache: on a miss the caller
 * waits for a real fetch, and a failed fetch never poisons the cache.
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
const inflight = new Map<ProviderKey, Promise<ProviderResult>>();

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

export function prime(provider: ProviderKey, result: ProviderResult, now: number = Date.now()): void {
  // Only successful fetches are reusable: replaying a failure would turn a
  // transient outage into a minute of offline cards.
  if (result.ok) cache.set(provider, { result, at: now });
  else cache.delete(provider);
}

export type UsageFetcher = (provider: ProviderKey) => Promise<ProviderResult>;

/** The real fetcher: same short-circuits (unconfigured, unknown key) as the API route. */
export const registryFetcher: UsageFetcher = (provider) => fetchOneUsage(provider);

/**
 * Fetch usage, reusing a fresh cached result and collapsing concurrent callers
 * for the same provider onto one upstream request.
 */
export async function liveUsage(
  provider: ProviderKey,
  fetchUsage: UsageFetcher = registryFetcher,
  now: number = Date.now(),
): Promise<ProviderResult> {
  const hit = peek(provider, now);
  if (hit) return hit;
  const pending = inflight.get(provider);
  if (pending) return pending;
  const p = fetchUsage(provider)
    .then((result) => {
      prime(provider, result, Date.now());
      return result;
    })
    .finally(() => {
      inflight.delete(provider);
    });
  inflight.set(provider, p);
  return p;
}

/** Test seam. */
export function clearCache(): void {
  cache.clear();
  inflight.clear();
}
