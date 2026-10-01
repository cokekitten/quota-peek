import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from './db';
import { clearCache, prime } from './liveCache';
import { maxServeAgeMs, serveUsage, staleAfterMs } from './serve';
import { sampleCount } from './store';
import { resetPoller } from './poller';
import type { ProviderKey, ProviderResult } from '../providers/types';

let dir: string;
const INTERVAL = 300_000;
const NOW = 1_800_000_000_000;

const reading = (over: Partial<ProviderResult> = {}): ProviderResult => ({
  ok: true,
  provider: 'claude',
  label: 'Claude Code',
  summary: { planLabel: 'Max', limits: [{ label: '5h', kind: '5h', percent: 40 }] },
  ...over,
});

const fetcher = (result: ProviderResult = reading()) => vi.fn(async () => result);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-serve-'));
  process.env.QP_DATA_DIR = dir;
  closeDb();
  clearCache();
  resetPoller();
});

afterEach(() => {
  closeDb();
  clearCache();
  resetPoller();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.QP_DATA_DIR;
});

describe('thresholds', () => {
  it('scales with the sampling interval', () => {
    expect(staleAfterMs(INTERVAL)).toBe(INTERVAL);
    expect(maxServeAgeMs(INTERVAL)).toBe(2 * INTERVAL);
  });
});

describe('serveUsage', () => {
  it('answers from the sampler last reading without calling the provider', async () => {
    prime('claude', reading(), NOW - 60_000);
    const fetchUsage = fetcher();
    const served = await serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(served.fromCache).toBe(true);
    expect(served.recorded).toBe(false);
    expect(served.at).toBe(NOW - 60_000);
    expect(served.result.summary?.limits[0].percent).toBe(40);
  });

  it('does not write the served reading to history a second time', async () => {
    prime('claude', reading(), NOW - 60_000);
    await serveUsage('claude', { fetchUsage: fetcher(), now: NOW, intervalMs: INTERVAL });
    expect(sampleCount()).toBe(0);
  });

  it('tags a reading that is more than one interval old as cached', async () => {
    prime('claude', reading(), NOW - INTERVAL - 30_000);
    const fetchUsage = fetcher();
    const served = await serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(served.result.stale).toBe(true); // the card's "cached" tag
  });

  it('goes upstream once the reading is older than two intervals', async () => {
    prime('claude', reading(), NOW - 2 * INTERVAL - 1);
    const fetchUsage = fetcher();
    const served = await serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(served.fromCache).toBe(false);
    expect(served.result.stale).toBeUndefined();
  });

  it('fetches and records when nothing has been read yet (fresh start, QP_POLL=0)', async () => {
    const served = await serveUsage('claude', { fetchUsage: fetcher(), now: NOW, intervalMs: INTERVAL });
    expect(served.fromCache).toBe(false);
    expect(served.recorded).toBe(true);
    expect(sampleCount()).toBe(1);
  });

  it('serves a recent failure as-is — a live outage should read as offline', async () => {
    const failed: ProviderResult = { ok: false, provider: 'claude', label: 'Claude Code', error: 'HTTP 429' };
    prime('claude', failed, NOW - 30_000);
    const fetchUsage = fetcher();
    const served = await serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(served.result.ok).toBe(false);
    expect(served.result.error).toBe('HTTP 429');
  });

  it('keeps an unconfigured card unconfigured instead of probing upstream', async () => {
    prime('glm', { ok: false, provider: 'glm', label: 'glm', notConfigured: true, error: 'set GLM_API_KEY' }, NOW);
    const fetchUsage = fetcher();
    const served = await serveUsage('glm' as ProviderKey, { fetchUsage, now: NOW, intervalMs: INTERVAL });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(served.result.notConfigured).toBe(true);
  });

  it('does not double-record when two page loads race the same fetch', async () => {
    // Both reads find nothing fresh, both reach liveUsage; one performs the
    // request and records it, the other joins in flight and must stay quiet.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchUsage = vi.fn(async (p: ProviderKey) => {
      await gate;
      return reading();
    });
    const a = serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    const b = serveUsage('claude', { fetchUsage, now: NOW, intervalMs: INTERVAL });
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect([first.recorded, second.recorded].filter(Boolean)).toHaveLength(1);
    expect(sampleCount()).toBe(1);
  });
});
