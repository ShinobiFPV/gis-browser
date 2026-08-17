import { describe, expect, it } from 'vitest';
import type { Bbox, Geometry } from './crs';
import { bboxWrapAware, bboxIntersects, bboxLobes, lonSpan, unionBboxWrapAware, wraps } from './antimeridian';

/** A MultiPolygon whose parts are each a degenerate box at the given longitudes. */
function partsAt(ranges: [number, number][], lat = 50): Geometry {
  return {
    type: 'MultiPolygon',
    coordinates: ranges.map(([w, e]) => [
      [
        [w, lat],
        [e, lat],
        [e, lat + 1],
        [w, lat + 1],
        [w, lat],
      ],
    ]),
  };
}

describe('bboxWrapAware', () => {
  it('leaves an ordinary feature alone', () => {
    const box = bboxWrapAware(partsAt([[-120, -110]]))!;
    expect(box).toMatchObject({ minx: -120, maxx: -110 });
    expect(wraps(box)).toBe(false);
  });

  it('wraps Alaska instead of returning the whole planet', () => {
    /*
     * The real numbers, from the live Census layer: the mainland and eastern Aleutians
     * reach -179.147, the western Aleutians reach 179.778. A naive min/max calls that
     * -179.147..179.778 -- a box containing every point on earth.
     */
    const alaska = partsAt(
      [
        [-179.147, -130.0],
        [172.0, 179.778],
      ],
      52,
    );
    const box = bboxWrapAware(alaska)!;

    expect(wraps(box)).toBe(true);
    expect(box.minx).toBeCloseTo(172.0, 3);
    expect(box.maxx).toBeCloseTo(-130.0, 3);
    // Alaska is wide, but nothing like the 359 degrees the naive box claims.
    expect(lonSpan(box)).toBeCloseTo(58, 0);
    expect(lonSpan(box)).toBeLessThan(90);
  });

  it('does not invent a wrap from an ordinary gap between parts', () => {
    // Two islands 30 degrees apart is just a country with a gap in it.
    const box = bboxWrapAware(partsAt([
      [-100, -95],
      [-65, -60],
    ]))!;
    expect(wraps(box)).toBe(false);
    expect(box).toMatchObject({ minx: -100, maxx: -60 });
  });

  it('wraps Fiji even though its parts are clipped exactly to ±180', () => {
    /*
     * Fiji is published already split at the antimeridian, so its longitudes include
     * both -180 and 180 and the naive box is the full -180..180. The 355-degree gap in
     * the middle -- the rest of the planet -- is what gives it away.
     */
    const box = bboxWrapAware(partsAt([
      [-180, -178.2],
      [176.9, 180],
    ], -18))!;

    expect(wraps(box)).toBe(true);
    expect(box.minx).toBeCloseTo(176.9, 3);
    expect(box.maxx).toBeCloseTo(-178.2, 3);
    expect(lonSpan(box)).toBeCloseTo(4.9, 3);
  });

  it('handles a single point', () => {
    const box = bboxWrapAware({ type: 'Point', coordinates: [10, 20] })!;
    expect(box).toEqual({ minx: 10, miny: 20, maxx: 10, maxy: 20 });
  });

  it('returns null for empty geometry', () => {
    expect(bboxWrapAware({ type: 'MultiPolygon', coordinates: [] })).toBeNull();
  });
});

describe('bboxLobes', () => {
  it('leaves an ordinary box as one lobe', () => {
    const b: Bbox = { minx: -10, miny: 0, maxx: 10, maxy: 5 };
    expect(bboxLobes(b)).toEqual([b]);
  });

  it('splits a wrapped box at the antimeridian', () => {
    const lobes = bboxLobes({ minx: 172, miny: 51, maxx: -130, maxy: 71 });
    expect(lobes).toEqual([
      { minx: 172, miny: 51, maxx: 180, maxy: 71 },
      { minx: -180, miny: 51, maxx: -130, maxy: 71 },
    ]);
  });
});

describe('bboxIntersects', () => {
  const alaska: Bbox = { minx: 172, miny: 51, maxx: -130, maxy: 71 };

  it('matches a point on either side of the antimeridian', () => {
    // Attu, in the western lobe.
    expect(bboxIntersects(alaska, { minx: 173, miny: 52, maxx: 173, maxy: 52 })).toBe(true);
    // Anchorage, in the eastern lobe.
    expect(bboxIntersects(alaska, { minx: -149, miny: 61, maxx: -149, maxy: 61 })).toBe(true);
  });

  it('does NOT match everywhere, which is the whole point', () => {
    // London. A naive -179..179 box would have claimed this.
    expect(bboxIntersects(alaska, { minx: -0.1, miny: 51.5, maxx: 0.1, maxy: 51.6 })).toBe(false);
    // Toronto.
    expect(bboxIntersects(alaska, { minx: -79.4, miny: 43.7, maxx: -79.3, maxy: 43.8 })).toBe(false);
  });

  it('respects latitude as well', () => {
    expect(bboxIntersects(alaska, { minx: 173, miny: -40, maxx: 173, maxy: -39 })).toBe(false);
  });
});

describe('unionBboxWrapAware', () => {
  it('keeps a wrap when merging the parts of one feature', () => {
    const west: Bbox = { minx: 172, miny: 51, maxx: 180, maxy: 54 };
    const east: Bbox = { minx: -180, miny: 51, maxx: -130, maxy: 71 };
    const merged = unionBboxWrapAware(west, east)!;

    // Both lobes touch the antimeridian, so this is genuinely continuous across it.
    expect(merged.miny).toBe(51);
    expect(merged.maxy).toBe(71);
    expect(lonSpan(merged)).toBeLessThanOrEqual(360);
  });

  it('merges two ordinary boxes plainly', () => {
    const merged = unionBboxWrapAware(
      { minx: -100, miny: 40, maxx: -90, maxy: 50 },
      { minx: -95, miny: 45, maxx: -80, maxy: 55 },
    )!;
    expect(merged).toEqual({ minx: -100, miny: 40, maxx: -80, maxy: 55 });
  });

  it('passes through a null side', () => {
    const b: Bbox = { minx: 1, miny: 2, maxx: 3, maxy: 4 };
    expect(unionBboxWrapAware(null, b)).toEqual(b);
    expect(unionBboxWrapAware(b, null)).toEqual(b);
    expect(unionBboxWrapAware(null, null)).toBeNull();
  });
});
