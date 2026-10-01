import { describe, expect, it } from 'vitest';
import { sparkGeometry, type SparkPoint } from './spark';

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
