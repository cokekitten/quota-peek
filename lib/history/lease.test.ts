import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLease, closeDb, leaseState, releaseLease } from './db';
import { pollOnce, resetPoller, stopPoller } from './poller';
import { sampleCount } from './store';
import type { ProviderKey, ProviderResult } from '../providers/types';

let dir: string;
const ok = (): ProviderResult => ({
  ok: true,
  provider: 'claude',
  label: 'Claude Code',
  summary: { limits: [{ label: '5h', kind: '5h', percent: 40 }] },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-lease-'));
  process.env.QP_DATA_DIR = dir;
  closeDb();
  resetPoller();
});

afterEach(() => {
  stopPoller();
  closeDb();
  resetPoller();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.QP_DATA_DIR;
});

describe('the sampling lease', () => {
  const T = 1_800_000_000_000;

  it('lets the first owner take it and refuses a second while it is valid', () => {
    expect(acquireLease('a:1', 60_000, T)).toBe(true);
    expect(acquireLease('b:1', 60_000, T + 1_000)).toBe(false);
  });

  it('lets the holder renew its own lease', () => {
    expect(acquireLease('a:1', 60_000, T)).toBe(true);
    expect(acquireLease('a:1', 60_000, T + 30_000)).toBe(true);
    expect(acquireLease('b:1', 60_000, T + 30_000)).toBe(false);
  });

  it('hands over once the lease expires — a dead owner must not block forever', () => {
    acquireLease('a:1', 60_000, T);
    expect(acquireLease('b:1', 60_000, T + 60_001)).toBe(true);
    expect(leaseState(T + 60_002)?.owner).toBe('b:1');
  });

  it('is released on request so another replica can take over immediately', () => {
    acquireLease('a:1', 600_000, T);
    releaseLease('a:1');
    expect(acquireLease('b:1', 60_000, T + 1)).toBe(true);
  });

  it('never lets two owners both believe they hold it', () => {
    // Sequential rounds stand in for the concurrent start of N replicas.
    const winners = Array.from({ length: 8 }, (_, i) => acquireLease(`host${i}:1`, 60_000, T));
    expect(winners.filter(Boolean)).toHaveLength(1);
  });
});

describe('pollOnce respects the lease', () => {
  it('skips the round and writes nothing when another instance owns sampling', async () => {
    acquireLease('other:1', 600_000, Date.now());
    const summary = await pollOnce({
      keys: ['claude'],
      owner: 'me:1',
      fetchUsage: async (p: ProviderKey) => ok(),
    });
    expect(summary.skipped).toBe('lease_held_elsewhere');
    expect(summary.providers).toHaveLength(0);
    expect(sampleCount()).toBe(0);
  });

  it('samples when it holds the lease, renewing it as it goes', async () => {
    const summary = await pollOnce({
      keys: ['claude'],
      owner: 'me:1',
      fetchUsage: async (p: ProviderKey) => ok(),
    });
    expect(summary.skipped).toBeUndefined();
    expect(summary.providers).toHaveLength(1);
    expect(sampleCount()).toBe(1);
    expect(leaseState()?.owner).toBe('me:1');
  });

  it('can be told to skip the lease for a single-process install', async () => {
    acquireLease('other:1', 600_000, Date.now());
    const summary = await pollOnce({
      keys: ['claude'],
      noLease: true,
      fetchUsage: async (p: ProviderKey) => ok(),
    });
    expect(summary.skipped).toBeUndefined();
    expect(sampleCount()).toBe(1);
  });
});
