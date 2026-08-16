import { describe, expect, it } from 'vitest';
import {
  closeRing,
  countParts,
  countRings,
  isCounterClockwise,
  rewindGeometry,
  rewindRing,
  roundGeometry,
  signedArea,
  validateGeometry,
  type Ring,
} from './winding';
import type { Geometry } from '../harvester/normalize/crs';

/** A unit square, counterclockwise, closed. */
const CCW: Ring = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];
const CW: Ring = [...CCW].reverse();

describe('signedArea', () => {
  it('is positive for counterclockwise and negative for clockwise', () => {
    expect(signedArea(CCW)).toBeGreaterThan(0);
    expect(signedArea(CW)).toBeLessThan(0);
    expect(isCounterClockwise(CCW)).toBe(true);
    expect(isCounterClockwise(CW)).toBe(false);
  });

  it('survives the tiny coordinates of a small reserve', () => {
    // A parcel roughly 30 m across, in degrees. The naive halved area underflows toward
    // the float floor; only the sign is ever used, so this must still be reliable.
    const tiny: Ring = [
      [-80.0, 45.0],
      [-79.9997, 45.0],
      [-79.9997, 45.0003],
      [-80.0, 45.0003],
      [-80.0, 45.0],
    ];
    expect(isCounterClockwise(tiny)).toBe(true);
    expect(isCounterClockwise([...tiny].reverse())).toBe(false);
  });
});

describe('closeRing', () => {
  it('appends the first position when a ring is open', () => {
    const open: Ring = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    expect(closeRing(open)).toHaveLength(4);
    expect(closeRing(open)[3]).toEqual([0, 0]);
  });

  it('leaves an already closed ring alone', () => {
    expect(closeRing(CCW)).toHaveLength(5);
  });
});

describe('rewindRing', () => {
  it('reverses only when the winding is wrong', () => {
    expect(rewindRing(CCW, true)).toEqual(CCW);
    expect(rewindRing(CW, true)).toEqual(CCW);
    expect(rewindRing(CCW, false)).toEqual(CW);
  });
});

describe('rewindGeometry', () => {
  it('makes exteriors counterclockwise and holes clockwise, per RFC 7946 section 3.1.6', () => {
    // Wound the ESRI way throughout: clockwise exterior, counterclockwise hole.
    const esriStyle: Geometry = {
      type: 'Polygon',
      coordinates: [
        CW,
        [
          [0.2, 0.2],
          [0.2, 0.8],
          [0.8, 0.8],
          [0.8, 0.2],
          [0.2, 0.2],
        ],
      ],
    };
    const out = rewindGeometry(esriStyle);
    const rings = out.coordinates as Ring[];
    expect(isCounterClockwise(rings[0]!)).toBe(true);
    expect(isCounterClockwise(rings[1]!)).toBe(false);
  });

  it('handles every part of a MultiPolygon independently', () => {
    const multi: Geometry = { type: 'MultiPolygon', coordinates: [[CW], [CCW]] };
    const out = rewindGeometry(multi);
    for (const poly of out.coordinates as Ring[][]) {
      expect(isCounterClockwise(poly[0]!)).toBe(true);
    }
  });

  it('keeps the first ring as the exterior rather than re-deriving it from area', () => {
    // A hole larger in extent than its exterior would be nonsense, but if a source ever
    // hands us one we must not silently reinterpret which ring is which.
    const odd: Geometry = {
      type: 'Polygon',
      coordinates: [
        CCW,
        [
          [0.1, 0.1],
          [0.1, 0.9],
          [0.9, 0.9],
          [0.9, 0.1],
          [0.1, 0.1],
        ],
      ],
    };
    const out = rewindGeometry(odd);
    expect((out.coordinates as Ring[])[0]![0]).toEqual([0, 0]);
  });

  it('passes lines through untouched, since they have no winding rule', () => {
    const line: Geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    expect(rewindGeometry(line)).toEqual(line);
  });
});

describe('roundGeometry', () => {
  it('rounds to the requested decimals and drops any third ordinate', () => {
    const g: Geometry = {
      type: 'Polygon',
      coordinates: [[[-80.123456789, 45.987654321, 120.5], [1, 2], [3, 4], [-80.123456789, 45.987654321, 120.5]]],
    };
    const out = roundGeometry(g, 6).coordinates as Ring[];
    expect(out[0]![0]).toEqual([-80.123457, 45.987654]);
    expect(out[0]![0]).toHaveLength(2);
  });

  it('does not flip a ring, so it is safe to run after rewinding', () => {
    const wound = rewindGeometry({ type: 'Polygon', coordinates: [CW] });
    const rounded = roundGeometry(wound, 6);
    expect(isCounterClockwise((rounded.coordinates as Ring[])[0]!)).toBe(true);
  });
});

describe('countRings and countParts', () => {
  it('counts rings across every part', () => {
    const multi: Geometry = { type: 'MultiPolygon', coordinates: [[CCW, CW], [CCW]] };
    expect(countRings(multi)).toBe(3);
    expect(countParts(multi)).toBe(2);
    expect(countRings({ type: 'Polygon', coordinates: [CCW] })).toBe(1);
    expect(countParts({ type: 'Polygon', coordinates: [CCW] })).toBe(1);
  });
});

describe('validateGeometry', () => {
  it('accepts a well-formed polygon', () => {
    expect(validateGeometry({ type: 'Polygon', coordinates: [CCW] })).toEqual([]);
  });

  it('reports a ring with too few positions', () => {
    const bad: Geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] };
    const problems = validateGeometry(bad);
    expect(problems[0]?.kind).toBe('degenerate-ring');
  });

  it('reports an unclosed ring', () => {
    const bad: Geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    expect(validateGeometry(bad)[0]?.kind).toBe('unclosed-ring');
  });

  it('names the offending ring as exterior or hole so the message is actionable', () => {
    const bad: Geometry = { type: 'Polygon', coordinates: [CCW, [[0, 0], [1, 1], [0, 0]]] };
    expect(validateGeometry(bad)[0]?.detail).toContain('hole');
  });

  it('rejects a non-area geometry', () => {
    expect(validateGeometry({ type: 'Point', coordinates: [0, 0] })[0]?.kind).toBe('empty-geometry');
  });
});
