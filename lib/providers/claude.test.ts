import { describe, expect, it } from 'vitest';
import { summarizeUsage } from './claude';

describe('summarizeUsage', () => {
  it('maps legacy five_hour/seven_day windows', () => {
    const limits = summarizeUsage({
      five_hour: { utilization: 7, resets_at: '2026-08-08T20:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-08-10T02:00:00Z' },
    });
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({ kind: '5h', percent: 7 });
    expect(limits[1]).toMatchObject({ kind: 'weekly', percent: 30 });
  });

  it('adds model-scoped weekly windows (e.g. Fable) as extra rows', () => {
    const limits = summarizeUsage({
      five_hour: { utilization: 7, resets_at: '2026-08-08T20:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-08-10T02:00:00Z' },
      limits: [
        { kind: 'session', group: 'session', percent: 7 },
        { kind: 'weekly_all', group: 'weekly', percent: 30 },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 48,
          resets_at: '2026-08-10T02:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' } },
          is_active: true,
        },
      ],
    });
    expect(limits).toHaveLength(3);
    const fable = limits[2];
    expect(fable).toMatchObject({
      label: 'Weekly · Fable',
      kind: 'weekly_scoped_fable',
      percent: 48,
      detail: 'binding',
      resetAt: '2026-08-10T02:00:00Z',
    });
    // session / weekly_all duplicates are skipped, not double-rendered.
    expect(limits.filter((l) => l.kind === 'weekly')).toHaveLength(1);
  });

  it('ignores scoped entries without a model name and non-active rows carry no detail', () => {
    const limits = summarizeUsage({
      limits: [
        { kind: 'weekly_scoped', percent: 10, scope: null },
        {
          kind: 'weekly_scoped',
          percent: 20,
          scope: { model: { display_name: 'Sonnet' } },
          is_active: false,
        },
      ],
    });
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ label: 'Weekly · Sonnet', percent: 20 });
    expect(limits[0].detail).toBeUndefined();
  });
});
