import type { Bbox, Geometry } from './crs';

/**
 * Bounding boxes for things that cross the antimeridian.
 *
 * A naive min/max over longitude is wrong for any feature with land on both sides of
 * ±180, and it is wrong in the most damaging possible direction: it returns -180..180,
 * a box that contains everywhere. Alaska is the case that forced this. Its parts run
 * from -179.147 (the mainland and eastern Aleutians) to 179.778 (Attu and the western
 * Aleutians), verified against the live Census layer, so the naive box for the State of
 * Alaska is the entire planet. So is Russia's, Fiji's, New Zealand's and Kiribati's.
 *
 * The catalog previously dodged this by discarding parts that were nowhere near Canada,
 * which was right for a Canadian catalog and is useless now: Attu is not noise, it is
 * Alaska.
 *
 * The fix is to measure longitude on a circle instead of a line. A set of longitudes has
 * a largest gap; the tightest box is the one that spans everything EXCEPT that gap. For
 * Alaska the largest gap is the Pacific between 179.778 and -179.147, so the box runs
 * 179.778 eastward through 180 to -179.147 -- 1.075 degrees wide, not 359.
 *
 * WRAPPED BOXES ARE STORED WITH minx > maxx. That convention is the standard one (it is
 * what OGC and GeoJSON's bbox spec both use for the antimeridian case) and every reader
 * of a bbox in this codebase must handle it -- see `bboxIntersects` and `bboxLobes`.
 */

/** True when the box crosses the antimeridian, i.e. runs east from minx through 180. */
export function wraps(b: Bbox): boolean {
  return b.minx > b.maxx;
}

/** Width in degrees of longitude, correct for wrapped boxes. */
export function lonSpan(b: Bbox): number {
  return wraps(b) ? 360 - b.minx + b.maxx : b.maxx - b.minx;
}

/**
 * Every distinct longitude in a geometry, plus the latitude range.
 * Kept separate from bboxOf so the wrap decision can be made over the whole set at once.
 */
function collect(geometry: Geometry): { lons: number[]; miny: number; maxy: number } | null {
  const lons: number[] = [];
  let miny = Infinity;
  let maxy = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (coords.length > 0 && typeof coords[0] === 'number') {
      const x = coords[0];
      const y = coords[1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      lons.push(x);
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      return;
    }
    for (const c of coords) visit(c);
  };

  visit(geometry.coordinates);
  return lons.length === 0 || !Number.isFinite(miny) ? null : { lons, miny, maxy };
}

/**
 * How wide a longitude gap has to be before it is read as the antimeridian rather than
 * as ordinary empty space inside a country.
 *
 * Russia spans 190 degrees the long way and its Pacific gap is about 170, so anything
 * near 180 is far too strict. Canada's widest internal gap is a few degrees. 120 sits in
 * the empty middle of that range: no real country has a 120-degree hole in it that is
 * not the ocean on the other side of the world.
 */
const MIN_WRAP_GAP_DEG = 120;

/**
 * The tightest bounding box for a geometry, wrapping across ±180 when that is smaller.
 *
 * Returns the same thing as the naive box for the overwhelming majority of features;
 * only geometry with a huge longitudinal gap is treated as wrapping.
 */
export function bboxWrapAware(geometry: Geometry): Bbox | null {
  const collected = collect(geometry);
  if (!collected) return null;
  return boxFromLons(collected.lons, collected.miny, collected.maxy);
}

/** The wrap decision itself, over a bare set of longitudes. */
function boxFromLons(lons: number[], miny: number, maxy: number): Bbox | null {
  if (lons.length === 0) return null;
  const sorted = [...lons].sort((a, b) => a - b);
  const west = sorted[0]!;
  const east = sorted[sorted.length - 1]!;

  // The gap that wraps through the antimeridian, plus every gap between adjacent points.
  let widestGap = 360 - east + west;
  let gapStart = east;
  let gapEnd = west;

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > widestGap) {
      widestGap = gap;
      gapStart = sorted[i - 1]!;
      gapEnd = sorted[i]!;
    }
  }

  // The widest gap is the one through the antimeridian: the plain box is already tightest.
  if (gapStart === east && gapEnd === west) return { minx: west, miny, maxx: east, maxy };

  // A gap inside the data only means a wrap if it is implausibly large for real land.
  if (widestGap < MIN_WRAP_GAP_DEG) return { minx: west, miny, maxx: east, maxy };

  // Span everything except the gap: east from its end, through 180, to its start.
  return { minx: gapEnd, miny, maxx: gapStart, maxy };
}

/**
 * A wrapped box split into the one or two ordinary boxes it covers.
 *
 * Anything that indexes or draws a bbox needs this, because a wrapped box is not a
 * rectangle in plain lon/lat space and no ordinary min/max comparison handles it.
 */
export function bboxLobes(b: Bbox): Bbox[] {
  if (!wraps(b)) return [b];
  return [
    { minx: b.minx, miny: b.miny, maxx: 180, maxy: b.maxy },
    { minx: -180, miny: b.miny, maxx: b.maxx, maxy: b.maxy },
  ];
}

/** Intersection test that is correct when either box wraps. */
export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  for (const x of bboxLobes(a)) {
    for (const y of bboxLobes(b)) {
      if (x.minx <= y.maxx && x.maxx >= y.minx && x.miny <= y.maxy && x.maxy >= y.miny) return true;
    }
  }
  return false;
}

/**
 * Union of two boxes, keeping the wrap-aware reading.
 *
 * Used when a multi-part feature is merged from several rows: taking a plain min/max of
 * two wrapped boxes would throw the wrap away and give back the whole planet again.
 */
export function unionBboxWrapAware(a: Bbox | null, b: Bbox | null): Bbox | null {
  if (!a) return b;
  if (!b) return a;

  const lobes = [...bboxLobes(a), ...bboxLobes(b)];
  const miny = Math.min(...lobes.map((l) => l.miny));
  const maxy = Math.max(...lobes.map((l) => l.maxy));

  // Re-run the gap decision over the lobe edges, so a merge can still come back wrapped
  // rather than flattening to -180..180.
  const edges = lobes.flatMap((l) => [l.minx, l.maxx]);
  return boxFromLons(edges, miny, maxy) ?? { ...a };
}
