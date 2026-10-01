import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from './db';
import { extractSample } from './extract';
import { clearCache, peek, prime, liveUsage } from './liveCache';
import { pollableKeys, pollIfIdle, pollOnce, resetPoller, startPoller, stopPoller } from './poller';
import { sampleCount } from './store';
import { PROVIDER_KEYS } from '../providers';
import type { ProviderKey, ProviderResult } from '../providers/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-poller-'));
  process.env.QP_DATA_DIR = dir;
  closeDb();
  clearCache();
  resetPoller();
});

afterEach(() => {
  stopPoller();
  resetPoller();
  closeDb();
  clearCache();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.QP_DATA_DIR;
});

const okResult = (provider: ProviderKey, percent = 40): ProviderResult => ({
  ok: true,
  provider,
  label: provider,
  summary: { limits: [{ label: '5h', kind: '5h', percent }] },
});

describe('pollOnce', () => {
  it('samples every configured provider and records each result', async () => {
    const seen: ProviderKey[] = [];
    const summary = await pollOnce({
      keys: ['claude', 'glm'],
      fetchUsage: async (p) => {
        seen.push(p);
        return okResult(p, seen.length * 10);
      },
    });
    expect(seen).toEqual(['claude', 'glm']); // sequential, deterministic order
    expect(summary.providers.map((p) => [p.provider, p.ok, p.rows])).toEqual([
      ['claude', true, 1],
      ['glm', true, 1],
    ]);
    expect(sampleCount()).toBe(2);
  });

  it('records a failed provider instead of dropping the round', async () => {
    const summary = await pollOnce({
      keys: ['claude', 'glm'],
      fetchUsage: async (p) =>
        p === 'glm' ? { ok: false, provider: 'glm', label: 'GLM', error: 'HTTP 429' } : okResult(p),
    });
    expect(summary.providers[1]).toMatchObject({ provider: 'glm', ok: false, errKind: 'error', rows: 0 });
    // The failure is on the timeline — a gap is data too.
    expect(sampleCount()).toBe(2);
  });

  it('keeps polling after a fetcher that throws outright', async () => {
    const summary = await pollOnce({
      keys: ['claude', 'glm'],
      fetchUsage: async (p) => {
        if (p === 'claude') throw new Error('socket hang up');
        return okResult(p);
      },
    });
    expect(summary.providers[0]).toMatchObject({ provider: 'claude', ok: false, errKind: 'error' });
    expect(summary.providers[1].ok).toBe(true);
  });

  it('only polls providers that have credentials', async () => {
    const calls: ProviderKey[] = [];
    // The real isConfigured() reads the filesystem/env; the injected fetcher
    // must never be called for an unconfigured provider.
    const keys = pollableKeys();
    expect(keys.every((k) => PROVIDER_KEYS.includes(k))).toBe(true);
    await pollOnce({
      keys,
      fetchUsage: async (p) => {
        calls.push(p);
        return okResult(p);
      },
    });
    expect(calls).toEqual(keys);
  });

  it('prunes on request, honouring QP_HISTORY_DAYS', async () => {
    process.env.QP_HISTORY_DAYS = '7';
    const old = Date.now() - 10 * 864e5;
    const stale = extractSample(okResult('claude'), 'poll', old);
    // Seed an out-of-window sample through the same path the poller uses.
    const { record } = await import('./store');
    record(stale, old);
    expect(sampleCount()).toBe(1);
    const summary = await pollOnce({ keys: [], fetchUsage: async (p) => okResult(p), prune: true });
    expect(summary.pruned).toBe(true);
    expect(sampleCount()).toBe(0);
    delete process.env.QP_HISTORY_DAYS;
  });
});

describe('pollIfIdle / startPoller', () => {
  it('does not re-enter while a round is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchUsage = vi.fn(async (p: ProviderKey) => {
      await gate;
      return okResult(p);
    });
    const first = pollIfIdle({ keys: ['claude'], fetchUsage });
    const second = await pollIfIdle({ keys: ['claude'], fetchUsage });
    expect(second).toBeNull();
    release();
    await first;
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it('fires on the interval and keeps a single timer no matter how often it is started', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async (p: ProviderKey) => okResult(p));
    startPoller({ keys: ['claude'], fetchUsage, intervalMs: 1000, initialDelayMs: 0 });
    startPoller({ keys: ['claude'], fetchUsage, intervalMs: 1000, initialDelayMs: 0 });
    startPoller({ keys: ['claude'], fetchUsage, intervalMs: 1000, initialDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUsage).toHaveBeenCalledTimes(1); // immediate first round, once
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchUsage).toHaveBeenCalledTimes(4); // 1 initial + 3 intervals, not 3×
    stopPoller();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchUsage).toHaveBeenCalledTimes(4); // stopped means stopped
  });

  it('delays the first round so a cold start does not hit every API at once', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async (p: ProviderKey) => okResult(p));
    startPoller({ keys: ['claude'], fetchUsage, intervalMs: 60_000, initialDelayMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });
});

describe('liveCache', () => {
  it('serves a fresh result without calling the provider again', async () => {
    const fetchUsage = vi.fn(async (p: ProviderKey) => okResult(p));
    const first = await liveUsage('claude', fetchUsage);
    const second = await liveUsage('claude', fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(second.result).toBe(first.result);
    expect(second.source).toBe('cache');
  });

  it('lets the sampler force a real read even inside the reuse window', async () => {
    const fetchUsage = vi.fn(async (p: ProviderKey) => okResult(p));
    await liveUsage('claude', fetchUsage);
    const forced = await liveUsage('claude', fetchUsage, Date.now(), { fresh: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(forced.source).toBe('fetch');
  });

  it('expires after the TTL (default 60s)', () => {
    prime('claude', okResult('claude'), 1_000);
    expect(peek('claude', 1_000 + 30_000)).not.toBeNull();
    expect(peek('claude', 1_000 + 60_001)).toBeNull();
  });

  it('refetches once the cached entry is past the TTL', async () => {
    const fetchUsage = vi.fn(async (p: ProviderKey) => okResult(p));
    await liveUsage('claude', fetchUsage, 0);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    // Backdate the cached entry, then ask as if 61s had passed.
    prime('claude', okResult('claude'), 0);
    await liveUsage('claude', fetchUsage, 61_000);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto one upstream request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchUsage = vi.fn(async (p: ProviderKey) => {
      await gate;
      return okResult(p);
    });
    const a = liveUsage('claude', fetchUsage);
    const b = liveUsage('claude', fetchUsage);
    release();
    await Promise.all([a, b]);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure', async () => {
    const bad = { ok: false, provider: 'claude' as ProviderKey, label: 'Claude Code', error: 'HTTP 500' };
    prime('claude', bad);
    expect(peek('claude')).toBeNull();
  });
});
