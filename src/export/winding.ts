import type { Geometry, Position } from '../harvester/normalize/crs';

/**
 * RFC 7946 ring winding, and the structural checks that go with it.
 *
 * §3.1.6: "A linear ring MUST follow the right-hand rule with respect to the area it
 * bounds, i.e., exterior rings are counterclockwise, and holes are clockwise."
 *
 * Services are inconsistent about this. ESRI's own convention is the exact opposite —
 * clockwise exteriors — so almost every polygon we fetch from an ArcGIS FeatureServer
 * arrives wound the wrong way for GeoJSON. Most consumers tolerate it; some, notably
 * anything that computes area or does point-in-polygon by winding number, silently
 * produce a hole where a landmass should be. We normalise on the way out.
 */

export type Ring = Position[];

/**
 * Twice the signed area, by the shoelace formula. Positive is counterclockwise.
 *
 * Returned undoubled and unhalved on purpose — only the sign is ever used, and halving
 * an already tiny number for a small reserve just moves it closer to the floating-point
 * floor.
 */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return sum;
}

export function isCounterClockwise(ring: Ring): boolean {
  return signedArea(ring) > 0;
}

/** Appends the first position if the ring is not already closed. */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

export function rewindRing(ring: Ring, wantCounterClockwise: boolean): Ring {
  const closed = closeRing(ring);
  if (closed.length < 4) return closed;
  return isCounterClockwise(closed) === wantCounterClockwise ? closed : [...closed].reverse();
}

/**
 * Rewinds a whole geometry to RFC 7946. Ring ORDER is preserved: the first ring of each
 * polygon stays the exterior. We do not attempt to re-derive which ring is the exterior
 * from area — every source we read puts the exterior first, and guessing would turn a
 * correct-but-oddly-wound polygon into a wrong one.
 */
export function rewindGeometry(geometry: Geometry): Geometry {
  const rewindPolygon = (rings: unknown): unknown => {
    if (!Array.isArray(rings)) return rings;
    return rings.map((ring, i) => rewindRing(ring as Ring, i === 0));
  };

  switch (geometry.type) {
    case 'Polygon':
      return { type: 'Polygon', coordinates: rewindPolygon(geometry.coordinates) };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: (geometry.coordinates as unknown[]).map(rewindPolygon),
      };
    default:
      // Lines and points have no winding rule. Passed through untouched.
      return geometry;
  }
}

/** Total ring count across a polygonal geometry. Used to detect holes lost in simplification. */
export function countRings(geometry: Geometry): number {
  switch (geometry.type) {
    case 'Polygon':
      return (geometry.coordinates as unknown[]).length;
    case 'MultiPolygon':
      return (geometry.coordinates as unknown[][]).reduce((n, poly) => n + poly.length, 0);
    default:
      return 0;
  }
}

/** Number of separate polygons. A multipart reserve or an archipelago has more than one. */
export function countParts(geometry: Geometry): number {
  switch (geometry.type) {
    case 'Polygon':
      return 1;
    case 'MultiPolygon':
      return (geometry.coordinates as unknown[]).length;
    default:
      return 1;
  }
}

/**
 * Rounds coordinates to a fixed number of decimal places.
 *
 * At 6 decimals a degree of latitude resolves to about 11 cm, which is far finer than any
 * boundary we index is actually surveyed to, and it typically halves the file size versus
 * the 15 significant figures that come off the wire. Applied last, after simplification
 * and rewinding, so it cannot change a ring's orientation.
 */
export function roundGeometry(geometry: Geometry, decimals: number): Geometry {
  const factor = 10 ** decimals;
  const round = (n: number): number => Math.round(n * factor) / factor;

  const mapCoords = (coords: unknown): unknown => {
    if (!Array.isArray(coords)) return coords;
    if (coords.length > 0 && typeof coords[0] === 'number') {
      // Height, if a source ever hands us one, is dropped: RFC 7946 allows it but no
      // broadcast graphic uses it and it doubles the coordinate count.
      return [round(coords[0]), round(coords[1] as number)];
    }
    return coords.map(mapCoords);
  };

  return { type: geometry.type, coordinates: mapCoords(geometry.coordinates) };
}

/**
 * Approximate area of a lon/lat ring, in hectares.
 *
 * A local equirectangular approximation — longitude scaled by cos(latitude) — rather than
 * a geodesic area. It is only ever used to tell an artist how big a dropped island was,
 * where being within a few percent over a few hundred metres is ample, and it avoids
 * pulling a geodesy dependency into the export path.
 */
export function approxAreaHa(ring: Ring): number {
  if (ring.length < 4) return 0;
  const meanLat = ring.reduce((s, p) => s + (p[1] as number), 0) / ring.length;
  const kx = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  const ky = 110_540;

  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += (a[0] as number) * kx * ((b[1] as number) * ky) - (b[0] as number) * kx * ((a[1] as number) * ky);
  }
  return Math.abs(sum / 2) / 10_000;
}

/** Exterior-ring area of every part, largest first. */
export function partAreasHa(geometry: Geometry): number[] {
  const polygons: unknown[][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as unknown[]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as unknown[][])
        : [];
  return polygons
    .map((rings) => (rings[0] ? approxAreaHa(rings[0] as Ring) : 0))
    .sort((a, b) => b - a);
}

/**
 * Area of every INTERIOR ring — holes and enclaves — largest first.
 *
 * Deliberately excludes exteriors. Counting all rings together conflates "a hole was
 * simplified away" with "a whole island disappeared, taking its lake with it", and made a
 * warning that said "lost 99 enclaves" while listing 21,287 areas.
 */
export function holeAreasHa(geometry: Geometry): number[] {
  const polygons: unknown[][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as unknown[]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as unknown[][])
        : [];
  return polygons
    .flatMap((rings) => rings.slice(1).map((r) => approxAreaHa(r as Ring)))
    .sort((a, b) => b - a);
}

/**
 * The areas present before simplification but not after.
 *
 * Simplification removes the smallest shapes first, so the dropped ones are the tail of
 * the descending-sorted list. Approximate by construction, and only ever used to put a
 * number on a warning.
 */
export function droppedAreas(before: number[], after: number[]): number[] {
  const lost = before.length - after.length;
  return lost <= 0 ? [] : before.slice(before.length - lost);
}

/** Formats an area for a warning an artist has to act on in a hurry. */
export function formatArea(hectares: number): string {
  if (hectares < 1) return `${(hectares * 10_000).toFixed(0)} m²`;
  if (hectares < 1000) return `${hectares.toFixed(1)} ha`;
  return `${(hectares / 100).toFixed(1)} km²`;
}

export interface RingProblem {
  kind: 'degenerate-ring' | 'unclosed-ring' | 'empty-geometry';
  detail: string;
}

/**
 * Structural validation. Anything reported here is a defect in what a service handed us,
 * not something to be quietly repaired — the brief is explicit that a bad boundary must
 * be visible rather than smoothed over.
 */
export function validateGeometry(geometry: Geometry): RingProblem[] {
  const problems: RingProblem[] = [];

  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    return [{ kind: 'empty-geometry', detail: `geometry type ${geometry.type} is not an area` }];
  }

  const polygons: unknown[][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as unknown[]]
      : (geometry.coordinates as unknown[][]);

  if (polygons.length === 0) {
    problems.push({ kind: 'empty-geometry', detail: 'no polygons' });
  }

  polygons.forEach((rings, p) => {
    rings.forEach((r, i) => {
      const ring = r as Ring;
      const where = `part ${p + 1}, ring ${i + 1}${i === 0 ? ' (exterior)' : ' (hole)'}`;
      if (ring.length < 4) {
        problems.push({ kind: 'degenerate-ring', detail: `${where} has only ${ring.length} positions` });
        return;
      }
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) {
        problems.push({ kind: 'unclosed-ring', detail: `${where} does not close` });
      }
    });
  });

  return problems;
}
