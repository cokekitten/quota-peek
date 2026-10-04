import { describe, expect, it } from 'vitest';
import { isConfigured, summarizeGeminiUsage } from './gemini';
import path from 'node:path';

describe('summarizeGeminiUsage', () => {
  it('maps standard 5h and weekly Gemini buckets', () => {
    const limits = summarizeGeminiUsage({
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              resetTime: '2026-10-04T21:45:43Z',
              remainingFraction: 0.958,
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: '2026-10-11T16:45:43Z',
              remainingFraction: 0.997,
            },
          ],
        },
      ],
    });

    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({
      label: '5h Window',
      kind: '5h',
      percent: 4.2,
      resetAt: '2026-10-04T21:45:43Z',
    });
    expect(limits[1]).toMatchObject({
      label: 'Weekly',
      kind: 'weekly',
      percent: 0.3,
      resetAt: '2026-10-11T16:45:43Z',
    });
  });

  it('includes 3P model buckets (Claude & GPT) if present', () => {
    const limits = summarizeGeminiUsage({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.8,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 1,
              resetTime: '2026-10-04T22:00:00Z',
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: '2026-10-11T17:00:00Z',
            },
          ],
        },
      ],
    });

    expect(limits).toHaveLength(3);
    expect(limits[0]).toMatchObject({ label: '5h Window', kind: '5h', percent: 20 });
    expect(limits[1]).toMatchObject({ label: '3P Models · 5h', kind: '3p_5h', percent: 0 });
    expect(limits[2]).toMatchObject({ label: '3P Models · Weekly', kind: '3p_weekly', percent: 15 });
  });

  it('handles empty response gracefully without crashing', () => {
    const limits = summarizeGeminiUsage({});
    expect(limits).toEqual([]);
  });
});

describe('isConfigured', () => {
  it('returns false for nonexistent path', () => {
    expect(isConfigured('/tmp/nonexistent-token-file-xyz')).toBe(false);
  });

  it('returns true if token file exists', () => {
    // Current test file exists
    expect(isConfigured(__filename)).toBe(true);
  });
});
