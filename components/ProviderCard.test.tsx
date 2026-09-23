import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Metric } from './ProviderCard';

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
