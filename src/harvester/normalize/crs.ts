import proj4 from 'proj4';
import { CANADA_BBOX } from '@shared/taxonomy';

/**
 * Reprojection to EPSG:4326.
 *
 * We always ASK services for 4326, but two things force us to reproject anyway:
 *   - some services ignore outSR or only publish a projected SRS
 *   - WFS 2.0 flips axis order on geographic CRS (lat,lon instead of lon,lat) in a way
 *     that varies by server and version. Rather than guess, the WFS client requests the
 *     source's own projected CRS -- where axis order is unambiguously easting,northing --
 *     and we convert here.
 *
 * Only the SRIDs the seeded registry actually serves are defined. An unknown SRID throws
 * rather than being passed through as if it were already lon/lat.
 */

const DEFS: Record<number, string> = {
  // WGS 84
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  // NAD83 -- geographic. Ontario LIO serves this.
  4269: '+proj=longlat +datum=NAD83 +no_defs',
  // Web Mercator. Newfoundland's riding service serves this.
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  // NAD83 / Statistics Canada Lambert. Every StatCan boundary file.
  3347:
    '+proj=lcc +lat_0=63.390675 +lon_0=-91.8666666666667 +lat_1=49 +lat_2=77 ' +
    '+x_0=6200000 +y_0=3000000 +datum=NAD83 +units=m +no_defs',
  // NAD83 / Canada Atlas Lambert. Elections Canada.
  3978: '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // NAD83(CSRS) / Canada Atlas Lambert. NRCan CLSS.
  3979: '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  // NAD83 / BC Albers.
  3005:
    '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 ' +
    '+datum=NAD83 +units=m +no_defs',
  // NAD83 / Ontario MNR Lambert.
  3161:
    '+proj=lcc +lat_0=0 +lon_0=-85 +lat_1=44.5 +lat_2=53.5 +x_0=930000 +y_0=6430000 ' +
    '+datum=NAD83 +units=m +no_defs',
};

for (const [code, def] of Object.entries(DEFS)) proj4.defs(`EPSG:${code}`, def);

export function isKnownSrid(srid: number): boolean {
  return srid in DEFS;
}

export function assertKnownSrid(srid: number, context: string): void {
  if (!isKnownSrid(srid)) {
    throw new Error(
      `Unknown SRID ${srid} at ${context}. Add its proj4 definition to harvester/normalize/crs.ts ` +
        `rather than assuming the coordinates are already lon/lat.`,
    );
  }
}

// --- Minimal GeoJSON geometry types. We only ever handle polygons and lines here. ---

export type Position = number[];
export interface Geometry {
  type: string;
  coordinates: unknown;
}

type Transform = (p: Position) => Position;

function mapCoords(coords: unknown, fn: Transform): unknown {
  if (!Array.isArray(coords)) return coords;
  if (coords.length > 0 && typeof coords[0] === 'number') return fn(coords as Position);
  return coords.map((c) => mapCoords(c, fn));
}

/**
 * Reprojects a GeoJSON geometry into EPSG:4326. A no-op for 4326 and 4269, whose
 * coordinates are already degrees on datums close enough for broadcast graphics
 * (NAD83 vs WGS84 differ by roughly a metre in Canada).
 */
export function toWgs84(geometry: Geometry, sourceSrid: number, context: string): Geometry {
  assertKnownSrid(sourceSrid, context);
  if (sourceSrid === 4326 || sourceSrid === 4269) return geometry;

  const from = `EPSG:${sourceSrid}`;
  const convert: Transform = (p) => {
    const [x, y] = proj4(from, 'EPSG:4326', [p[0] as number, p[1] as number]);
    return [x, y];
  };

  return { type: geometry.type, coordinates: mapCoords(geometry.coordinates, convert) };
}

/**
 * Reprojects OUT of EPSG:4326 into a projected CRS, for SVG export.
 *
 * The inverse of toWgs84. Kept here so every proj4 definition in the app lives in one
 * file: an SVG can only be drawn in a CRS the harvester already knows how to read back.
 */
export function fromWgs84(geometry: Geometry, targetSrid: number, context: string): Geometry {
  assertKnownSrid(targetSrid, context);
  if (targetSrid === 4326 || targetSrid === 4269) return geometry;

  const to = `EPSG:${targetSrid}`;
  const convert: Transform = (p) => {
    const [x, y] = proj4('EPSG:4326', to, [p[0] as number, p[1] as number]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(
        `Projecting ${context} into EPSG:${targetSrid} produced a non-finite coordinate from ` +
          `lon/lat ${String(p[0])},${String(p[1])}. The geometry lies outside the projection's valid area.`,
      );
    }
    return [x, y];
  };

  return { type: geometry.type, coordinates: mapCoords(geometry.coordinates, convert) };
}

/** Swaps every position in place. Used only when a WFS is caught emitting lat,lon. */
export function swapAxes(geometry: Geometry): Geometry {
  return {
    type: geometry.type,
    coordinates: mapCoords(geometry.coordinates, (p) => [p[1] as number, p[0] as number]),
  };
}

export interface Bbox {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export function bboxOf(geometry: Geometry): Bbox | null {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (coords.length > 0 && typeof coords[0] === 'number') {
      const x = coords[0];
      const y = coords[1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      return;
    }
    for (const c of coords) visit(c);
  };

  visit(geometry.coordinates);
  if (!Number.isFinite(minx)) return null;
  return { minx, miny, maxx, maxy };
}

export function unionBbox(a: Bbox | null, b: Bbox | null): Bbox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minx: Math.min(a.minx, b.minx),
    miny: Math.min(a.miny, b.miny),
    maxx: Math.max(a.maxx, b.maxx),
    maxy: Math.max(a.maxy, b.maxy),
  };
}

/** Grows a bbox by `pad` degrees. Used to offset generalisation shrink. */
export function padBbox(b: Bbox, pad: number): Bbox {
  return { minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad };
}

export interface EnvelopeCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Canada's rough lon/lat envelope, with a little slack for islands and offshore
 * boundaries. A failure here almost always means an unhandled CRS or a WFS axis flip,
 * and the brief is explicit that it must fail loudly rather than be clamped away.
 */
export function withinCanada(b: Bbox): EnvelopeCheck {
  const { minLon, minLat, maxLon, maxLat } = CANADA_BBOX;
  const slack = 2;

  if (b.minx < minLon - slack || b.maxx > maxLon + slack) {
    return { ok: false, reason: `longitude ${b.minx.toFixed(3)}..${b.maxx.toFixed(3)} outside ${minLon}..${maxLon}` };
  }
  if (b.miny < minLat - slack || b.maxy > maxLat + slack) {
    return { ok: false, reason: `latitude ${b.miny.toFixed(3)}..${b.maxy.toFixed(3)} outside ${minLat}..${maxLat}` };
  }
  return { ok: true };
}

/**
 * True when a bbox looks like it has lat and lon the wrong way round -- the signature of
 * a WFS 2.0 axis flip. Canada's longitudes are all strongly negative and its latitudes
 * all positive, so a swapped bbox is unmistakable.
 */
export function looksAxisSwapped(b: Bbox): boolean {
  const asIs = withinCanada(b).ok;
  if (asIs) return false;
  const swapped: Bbox = { minx: b.miny, miny: b.minx, maxx: b.maxy, maxy: b.maxx };
  return withinCanada(swapped).ok;
}

export function countVertices(geometry: Geometry): number {
  let n = 0;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (coords.length > 0 && typeof coords[0] === 'number') {
      n++;
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geometry.coordinates);
  return n;
}
