/**
 * What a page request answers with.
 *
 * The sampler already fetches every provider on a fixed interval, so a page
 * load re-fetching them all is duplicated work *and* a second source of the
 * rate limiting (Claude's card goes offline because we keep knocking on an API
 * that answers 429). So a read is served from the last reading when that
 * reading is still young enough:
 *
 *   age ≤ 1 interval  → serve as-is
 *   age ≤ 2 intervals → serve, tagged `stale` (the card already shows "cached")
 *   otherwise         → fetch live, and record the read
 *
 * A served read is *not* recorded again — the sampler wrote that exact reading
 * to the timeline already, and re-writing it would fill the refresh log with
 * one row per page view.
 */

import { extractSample } from './extract';
import { latestResult, liveUsage, type LiveResult, type UsageFetcher } from './liveCache';
import { pollIntervalMs } from './series';
import { record } from './store';
import type { ProviderKey, ProviderResult } from '../providers/types';

/** Past one interval the reading may be a cycle behind — say so on the card. */
export function staleAfterMs(intervalMs: number = pollIntervalMs()): number {
  return intervalMs;
}

/** Past two intervals the sampler has probably stalled — go get fresh data. */
export function maxServeAgeMs(intervalMs: number = pollIntervalMs()): number {
  return 2 * intervalMs;
}

export interface ServedUsage {
  result: ProviderResult;
  /** When the value was obtained upstream. */
  at: number;
  /** True when this came from the sampler's last reading. */
  fromCache: boolean;
  /** True when a history sample was written for this read. */
  recorded: boolean;
}

export interface ServeOptions {
  fetchUsage?: UsageFetcher;
  now?: number;
  intervalMs?: number;
  /** Skip writing history (tests, read-only callers). */
  record?: boolean;
}

export async function serveUsage(
  provider: ProviderKey,
  opts: ServeOptions = {},
): Promise<ServedUsage> {
  const now = opts.now ?? Date.now();
  const interval = opts.intervalMs ?? pollIntervalMs();
  const hit = latestResult(provider);
  const age = hit ? now - hit.at : Infinity;
  if (hit && age <= maxServeAgeMs(interval)) {
    return {
      result: age > staleAfterMs(interval) ? { ...hit.result, stale: true } : hit.result,
      at: hit.at,
      fromCache: true,
      recorded: false,
    };
  }

  const live: LiveResult = await liveUsage(provider, opts.fetchUsage, now);
  let recorded = false;
  if (live.source === 'fetch' && opts.record !== false) {
    const sample = extractSample(live.result, 'page', live.at);
    record(sample, live.at);
    recorded = true;
  }
  return { result: live.result, at: live.at, fromCache: false, recorded };
}
