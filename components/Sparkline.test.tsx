import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Sparkline, { sparkGeometry, type SparkPoint } from './Sparkline';

const pts = (vs: number[], step = 1): SparkPoint[] =>
  vs.map((v, i) => ({ t: 1_000 + i * step, v }));

describe('sparkGeometry', () => {
  it('maps a rising series to a line that starts low-left and ends high-right', () => {
    const g = sparkGeometry(pts([0, 5, 10]), 100, 20);
    expect(g.count).toBe(3);
    expect(g.paths).toHaveLength(1);
    expect(g.paths[0]).toBe('M0,18.5 L50,10 L100,1.5');
    expect(g.end).toEqual({ x: 100, y: 1.5 });
  });

  it('draws a flat series down the middle instead of pinning it to an edge', () => {
    const g = sparkGeometry(pts([7, 7, 7]), 100, 20);
    expect(g.paths[0]).toBe('M0,10 L50,10 L100,10');
  });

  it('splits into separate paths at a poller gap', () => {
    const g = sparkGeometry(
      [
        { t: 0, v: 1 },
        { t: 1, v: 2 },
        { t: 50, v: 3, br: 1 },
        { t: 51, v: 4 },
      ],
      100,
      20,
    );
    expect(g.paths).toHaveLength(2);
  });

  it('renders a single point as a dot-sized segment', () => {
    const g = sparkGeometry(pts([3]), 100, 20);
    expect(g.paths).toHaveLength(1);
    expect(g.paths[0]).toMatch(/^M50,10 l0\.01,0$/);    expect(g.end).toEqual({ x: 50, y: 10 });
  });

  it('reports reset positions without dropping the points', () => {
    const g = sparkGeometry(
      [
        { t: 0, v: 98 },
        { t: 1, v: 0, reset: 1 },
        { t: 2, v: 3 },
      ],
      100,
      20,
    );
    expect(g.resets).toHaveLength(1);
    expect(g.count).toBe(3);
  });

  it('ignores non-finite values and handles the empty case', () => {
    expect(sparkGeometry([]).count).toBe(0);
    expect(sparkGeometry([{ t: 0, v: Number.NaN }]).count).toBe(0);
  });
});

describe('Sparkline', () => {
  it('renders one path plus the end dot, and nothing at all without points', () => {
    const html = renderToStaticMarkup(<Sparkline points={pts([1, 2, 3])} title="3 readings" />);
    expect(html).toContain('<svg');
    expect(html.match(/<path/g)).toHaveLength(1);
    expect(html).toContain('<circle');
    expect(html).toContain('<title>3 readings</title>');
    expect(renderToStaticMarkup(<Sparkline points={[]} />)).toBe('');
  });

  it('uses a non-scaling stroke so the line stays 1.25px at any card width', () => {
    const html = renderToStaticMarkup(<Sparkline points={pts([1, 2])} />);
    expect(html).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toContain('preserveAspectRatio="none"');
  });
});
