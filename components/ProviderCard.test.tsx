import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { deltaBadge, Metric } from './ProviderCard';
import type { HistoryDelta, HistorySeries } from '@/lib/history/series';

describe('Metric', () => {
  it('renders a money row as one bare amount — no bar, no percent', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="Balance"
        limit={{ label: 'Balance', kind: 'balance', percent: 0, used: 143.59, unit: '¥' }}
      />,
    );
    expect(html).toContain('¥143.59');
    expect(html).not.toContain('class="bar"');
    expect(html).not.toMatch(/>0%</);
    expect(html.match(/143\.59/g)).toHaveLength(1);
  });

  it('keeps the bar and percent for usage rows', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="Monthly"
        limit={{
          label: 'Monthly',
          kind: 'monthly',
          percent: 16,
          used: 13_486_940_705,
          total: 82_000_000_000,
          unit: 'cr',
        }}
      />,
    );
    expect(html).toContain('class="bar"');
    expect(html).toMatch(/>16%</);
    expect(html).toContain('13.5B cr / 82B cr');
  });

  it('caps the bar width but not the number when usage exceeds the quota', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="Spend / Balance"
        limit={{ label: 'Spend / Balance', kind: 'spend', percent: 128, used: 2428.85, total: 1897.06, unit: '¥' }}
      />,
    );
    expect(html).toMatch(/>128%</);
    expect(html).toContain('width:100%');
    expect(html).not.toContain('width:128%');
  });

  it('renders the pace delta on money rows (过多/过少)', () => {
    const resetAt = new Date(Date.now() + 10 * 864e5).toISOString();
    const html = renderToStaticMarkup(
      <Metric
        label="Spend / Balance"
        limit={{ label: 'Spend / Balance', kind: 'spend', percent: 50, used: 1, total: 1, unit: '¥', resetAt }}
      />,
    );
    // 10 of 30 days left → 66.7% expected by even pace; 50% actual → 17 under
    expect(html).toContain('class="pace under"');
    expect(html).toContain('-17%');
  });

  it('renders merged estimate rows without the ≈ marker', () => {
    const html = renderToStaticMarkup(
      <Metric label="Weekly" limit={{ label: 'Weekly', kind: 'weekly', percent: 65, estimated: true }} />,
    );
    expect(html).not.toContain('≈');
    expect(html).toContain('65%');
  });

  it('renders the reset countdown on money rows', () => {
    // 7 d 1 hr out — the extra hour keeps fmtRel's day bucket stable across
    // the millisecond between computing the deadline and rendering it
    const resetAt = new Date(Date.now() + 7 * 864e5 + 36e5).toISOString();
    const html = renderToStaticMarkup(
      <Metric
        label="Month Spend"
        limit={{ label: 'Month Spend', kind: 'balance', percent: 0, used: 12.4, unit: '$', resetAt }}
      />,
    );
    expect(html).toContain('Resets in 7 d');
  });

  it('still surfaces detail notes on money rows', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="Balance"
        limit={{
          label: 'Balance',
          kind: 'balance',
          percent: 0,
          used: 69.5,
          unit: '¥',
          detail: 'insufficient for API calls',
        }}
      />,
    );
    expect(html).toContain('insufficient for API calls');
  });
});

describe('deltaBadge', () => {
  const NOW = 1_800_000_000_000;

  it('shows a percentage-point change since the previous reading', () => {
    expect(deltaBadge({ kind: 'pp', value: 2.5, at: NOW - 5 * 60_000, gapMs: 5 * 60_000 }, NOW)).toEqual({
      text: '+2.5%',
      // 2.5pp is a normal 5-minute move: neutral, not an alarm.
      cls: 'warn',
      title: '2.5 percentage points since 5 min',
    });
  });

  it('grades by magnitude, not by direction', () => {
    // The whole point: a +1pp tick on a 5-minute poll is routine and must not
    // light up red (it used to), while a double-digit jump should.
    const at = NOW - 5 * 60_000;
    expect(deltaBadge({ kind: 'pp', value: 1, at, gapMs: 0 }, NOW)?.cls).toBe('even');
    expect(deltaBadge({ kind: 'pp', value: -1, at, gapMs: 0 }, NOW)?.cls).toBe('even');
    expect(deltaBadge({ kind: 'pp', value: 7.4, at, gapMs: 0 }, NOW)?.cls).toBe('warn');
    expect(deltaBadge({ kind: 'pp', value: 12.8, at, gapMs: 0 }, NOW)?.cls).toBe('crit');
    expect(deltaBadge({ kind: 'pp', value: -12.8, at, gapMs: 0 }, NOW)?.cls).toBe('crit');
  });

  it('rounds a tiny change to ±0 rather than noise', () => {
    const b = deltaBadge({ kind: 'pp', value: 0.01, at: NOW - 60_000, gapMs: 60_000 }, NOW);
    expect(b?.text).toBe('±0%');
    expect(b?.cls).toBe('even');
  });

  it('says the window rolled over instead of claiming a -98% drop', () => {
    const b = deltaBadge({ kind: 'reset', at: NOW - 5 * 60_000 }, NOW);
    expect(b?.text).toBe('↻ reset');
    expect(b?.cls).toBe('even');
    expect(b?.title).toMatch(/rolled over/i);
  });

  it('formats money deltas with the row unit', () => {
    const b = deltaBadge({ kind: 'abs', value: -2.5, at: NOW - 3 * 3_600_000, gapMs: 3 * 3_600_000, unit: '¥' }, NOW);
    expect(b?.text).toBe('-¥2.5');
    expect(b?.cls).toBe('even');
    expect(b?.title).toBe('¥2.5 since 3 h');
  });

  it('grades a money delta against the row it belongs to', () => {
    // ¥2.5 is noise on a ¥1587 balance and a real event on a ¥20 one.
    const d = (v: number): HistoryDelta => ({ kind: 'abs', value: v, at: NOW - 300_000, gapMs: 0, unit: '¥' });
    expect(deltaBadge(d(-2.5), NOW, 1587)?.cls).toBe('even');
    expect(deltaBadge(d(-2.5), NOW, 20)?.cls).toBe('crit');
    expect(deltaBadge(d(-0.8), NOW, 20)?.cls).toBe('warn');
    // The tooltip carries the relative size, since "¥2.5" alone says nothing.
    expect(deltaBadge(d(-2.5), NOW, 1587)?.title).toContain('0.16% of ¥1587');
  });

  it('returns null when there is no history yet', () => {
    expect(deltaBadge(null, NOW)).toBeNull();
    expect(deltaBadge(undefined, NOW)).toBeNull();
  });
});

describe('Metric with history', () => {
  const series = (over: Partial<HistorySeries> = {}): HistorySeries => ({
    key: 'merged:5h',
    provider: 'claude',
    scope: 'merged',
    kind: '5h',
    label: '5h Window',
    mode: 'percent',
    unit: null,
    points: [
      { t: 1, v: 30 },
      { t: 2, v: 42 },
    ],
    delta: { kind: 'pp', value: 12, at: 2, gapMs: 1 },
    estimated: false,
    stale: false,
    ...over,
  });

  it('shows the change badge next to the percent, and no chart', () => {
    const html = renderToStaticMarkup(
      <Metric label="5h Window" limit={{ label: '5h', kind: '5h', percent: 42 }} series={series()} />,
    );
    expect(html).toContain('+12.0%');
    // The dashboard stays a glanceable snapshot: a trend line under every bar
    // read as a stray rule. Curves live on /history.
    expect(html).not.toContain('<svg');
  });

  it('badges money rows in their own unit', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="Balance"
        limit={{ label: 'Balance', kind: 'balance', percent: 0, used: 141.09, unit: '¥' }}
        series={series({
          key: 'merged:balance',
          kind: 'balance',
          mode: 'absolute',
          unit: '¥',
          delta: { kind: 'abs', value: -2.5, at: 2, gapMs: 1, unit: '¥' },
        })}
      />,
    );
    expect(html).toContain('-¥2.5');
  });

  it('shows no badge at all when there is nothing to compare against', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="5h Window"
        limit={{ label: '5h', kind: '5h', percent: 42 }}
        series={series({ points: [{ t: 1, v: 42 }], delta: null })}
      />,
    );
    expect(html).not.toContain('class="delta');
    expect(html).toMatch(/>42%</);
  });

  it('still renders the row when the sampler has stalled', () => {
    const html = renderToStaticMarkup(
      <Metric
        label="5h Window"
        limit={{ label: '5h', kind: '5h', percent: 42 }}
        series={series({ stale: true })}
      />,
    );
    expect(html).toMatch(/>42%</);
    expect(html).toContain('+12.0%');
  });
});

describe('a drop no window reset explains', () => {
  const NOW = 1_800_000_000_000;

  it('explains a large drop in the tooltip without changing its colour', () => {
    const b = deltaBadge(
      { kind: 'pp', value: -12, at: NOW - 300_000, gapMs: 0, suspect: 'stable-reset' },
      NOW,
    );
    expect(b?.text).toBe('-12.0%');
    expect(b?.title).toMatch(/no window reset/);
    // Same magnitude band as a +12pp jump — the tooltip explains, colour doesn't.
    expect(b?.cls).toBe(
      deltaBadge({ kind: 'pp', value: 12, at: NOW - 300_000, gapMs: 0 }, NOW)?.cls,
    );
  });

  it('says when a reset cannot be ruled out because the row has no reset time', () => {
    const b = deltaBadge(
      { kind: 'pp', value: -30, at: NOW - 300_000, gapMs: 0, suspect: 'no-reset-info' },
      NOW,
    );
    expect(b?.title).toMatch(/cannot be ruled out/);
  });

  it('leaves ordinary drops unannotated', () => {
    const b = deltaBadge({ kind: 'pp', value: -5, at: NOW - 300_000, gapMs: 0 }, NOW);
    expect(b?.title).toBe('5.0 percentage points since 5 min');
  });
});
