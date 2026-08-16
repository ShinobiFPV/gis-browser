import { describe, expect, it } from 'vitest';
import {
  bboxOf,
  countVertices,
  isKnownSrid,
  looksAxisSwapped,
  padBbox,
  swapAxes,
  toWgs84,
  unionBbox,
  withinCanada,
} from './crs';

describe('SRID coverage', () => {
  it('knows every SRID the seeded registry serves', () => {
    for (const srid of [4326, 4269, 3857, 3347, 3978, 3979, 3005, 3161]) {
      expect(isKnownSrid(srid), `EPSG:${srid}`).toBe(true);
    }
  });

  it('refuses an SRID it has no definition for', () => {
    expect(isKnownSrid(2953)).toBe(false);
    expect(() => toWgs84({ type: 'Point', coordinates: [0, 0] }, 2953, 'test')).toThrow(/Unknown SRID 2953/);
  });
});

describe('toWgs84', () => {
  it('leaves already-geographic coordinates alone', () => {
    const g = { type: 'Point', coordinates: [-80.05, 45.33] };
    expect(toWgs84(g, 4326, 't')).toBe(g);
    expect(toWgs84(g, 4269, 't')).toBe(g);
  });

  it('converts StatCan Lambert to lon/lat inside Canada', () => {
    // A point near the Lambert projection origin must land near its central meridian.
    const g = { type: 'Point', coordinates: [6200000, 3000000] };
    const out = toWgs84(g, 3347, 't') as { coordinates: number[] };
    expect(out.coordinates[0]).toBeCloseTo(-91.8666, 2);
    expect(out.coordinates[1]).toBeCloseTo(63.3906, 2);
  });

  it('converts Canada Atlas Lambert to lon/lat', () => {
    const out = toWgs84({ type: 'Point', coordinates: [0, 0] }, 3978, 't') as { coordinates: number[] };
    expect(out.coordinates[0]).toBeCloseTo(-95, 3);
    expect(out.coordinates[1]).toBeCloseTo(49, 3);
  });

  it('converts BC Albers to lon/lat', () => {
    const out = toWgs84({ type: 'Point', coordinates: [1000000, 0] }, 3005, 't') as { coordinates: number[] };
    expect(out.coordinates[0]).toBeCloseTo(-126, 3);
    expect(out.coordinates[1]).toBeCloseTo(45, 3);
  });

  it('walks nested polygon rings', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1000, 0],
          [1000, 1000],
          [0, 0],
        ],
      ],
    };
    const out = toWgs84(poly, 3978, 't') as { coordinates: number[][][] };
    expect(out.coordinates[0]).toHaveLength(4);
    for (const p of out.coordinates[0]!) {
      expect(p[0]).toBeGreaterThan(-100);
      expect(p[0]).toBeLessThan(-90);
    }
  });
});

describe('bbox helpers', () => {
  const poly = {
    type: 'Polygon',
    coordinates: [
      [
        [-80.1, 45.3],
        [-80.0, 45.3],
        [-80.0, 45.4],
        [-80.1, 45.4],
        [-80.1, 45.3],
      ],
    ],
  };

  it('computes a bbox from nested coordinates', () => {
    expect(bboxOf(poly)).toEqual({ minx: -80.1, miny: 45.3, maxx: -80.0, maxy: 45.4 });
  });

  it('returns null for an empty geometry', () => {
    expect(bboxOf({ type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('counts vertices', () => {
    expect(countVertices(poly)).toBe(5);
  });

  it('pads outward, since generalisation can only pull vertices inward', () => {
    const p = padBbox({ minx: -80, miny: 45, maxx: -79, maxy: 46 }, 0.005);
    expect(p.minx).toBeCloseTo(-80.005);
    expect(p.maxy).toBeCloseTo(46.005);
  });

  it('unions two boxes and tolerates nulls', () => {
    const a = { minx: -80, miny: 45, maxx: -79, maxy: 46 };
    const b = { minx: -81, miny: 44, maxx: -80.5, maxy: 45.5 };
    expect(unionBbox(a, b)).toEqual({ minx: -81, miny: 44, maxx: -79, maxy: 46 });
    expect(unionBbox(null, b)).toBe(b);
    expect(unionBbox(a, null)).toBe(a);
    expect(unionBbox(null, null)).toBeNull();
  });
});

describe('Canadian envelope validation', () => {
  it('accepts a boundary inside Canada', () => {
    expect(withinCanada({ minx: -80.1, miny: 45.3, maxx: -80.0, maxy: 45.4 }).ok).toBe(true);
  });

  it('rejects coordinates that are plainly not in Canada', () => {
    const check = withinCanada({ minx: 2.2, miny: 48.8, maxx: 2.4, maxy: 48.9 });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/longitude/);
  });

  it('spots a WFS axis-order flip', () => {
    // Parry Sound with lat and lon the wrong way round.
    const swapped = { minx: 45.3, miny: -80.1, maxx: 45.4, maxy: -80.0 };
    expect(withinCanada(swapped).ok).toBe(false);
    expect(looksAxisSwapped(swapped)).toBe(true);
  });

  it('does not claim a swap for data that is simply wrong', () => {
    expect(looksAxisSwapped({ minx: 2.2, miny: 48.8, maxx: 2.4, maxy: 48.9 })).toBe(false);
  });

  it('swapAxes actually reverses positions', () => {
    const out = swapAxes({ type: 'Point', coordinates: [45.3, -80.1] }) as { coordinates: number[] };
    expect(out.coordinates).toEqual([-80.1, 45.3]);
  });
});
