import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import { bboxOf, intersectsCanada, type Bbox, type Geometry } from '../normalize/crs';
import type { IndexedRow } from '../catalogs/esri-rest';

/**
 * Reading an extracted shapefile.
 *
 * Two decisions here are load-bearing, and both came out of looking at the real files
 * rather than the registry:
 *
 * CRS comes from the .prj, not from the registry. The Elections Canada FED archive is
 * seeded as EPSG:3978, but its .prj is False_Easting 6200000 / Central_Meridian
 * -91.8667 -- Statistics Canada Lambert, EPSG:3347 -- and reprojecting with 3978 puts
 * Canada in the Atlantic off Portugal. proj4 parses the WKT directly, so the file's own
 * declaration is used and a disagreement with the registry is reported rather than
 * silently resolved either way.
 *
 * Encoding comes from the .cpg. Every archive checked ships one and every one says UTF-8,
 * but the default in the shapefile spec is effectively unspecified, and guessing wrong
 * turns "Terra Nova—Les Péninsules" into mojibake that then becomes a search alias.
 */

export class ShapefileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapefileError';
  }
}

export interface ShapefileSet {
  shp: string;
  dbf: string | null;
  prj: string | null;
  cpg: string | null;
  /** Base name without extension, used to identify the layer. */
  layer: string;
}

/**
 * Groups extracted files into shapefile sets.
 *
 * Archives name their layers unpredictably -- the Aboriginal Lands download is
 * AL_TA_CA_2_187_eng.shp, with a version number in the middle -- so sets are discovered
 * rather than assumed.
 */
export function discoverLayers(files: string[]): ShapefileSet[] {
  const shps = files.filter((f) => f.toLowerCase().endsWith('.shp') && !f.toLowerCase().endsWith('.shp.xml'));

  return shps.map((shp) => {
    const stem = shp.slice(0, -4);
    const sidecar = (ext: string): string | null => {
      for (const candidate of [stem + ext, stem + ext.toUpperCase()]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    };
    return {
      shp,
      dbf: sidecar('.dbf'),
      prj: sidecar('.prj'),
      cpg: sidecar('.cpg'),
      layer: basename(stem),
    };
  });
}

/**
 * Picks which layer to ingest.
 *
 * A single layer is used without ceremony. Several is ambiguous, and guessing would mean
 * silently indexing the wrong dataset, so `layer_id` must name one.
 */
export function selectLayer(sets: ShapefileSet[], layerId: string | null, sourceName: string): ShapefileSet {
  if (sets.length === 0) {
    throw new ShapefileError(`No .shp file found in the archive for "${sourceName}".`);
  }
  if (sets.length === 1) return sets[0]!;

  const wanted = layerId?.trim();
  if (!wanted) {
    throw new ShapefileError(
      `The archive for "${sourceName}" contains ${sets.length} layers ` +
        `(${sets.map((s) => s.layer).join(', ')}). Set layer_id to name the one to index ` +
        `rather than having the harvester guess.`,
    );
  }

  const found = sets.find((s) => s.layer.toLowerCase() === wanted.toLowerCase());
  if (!found) {
    throw new ShapefileError(
      `Layer "${wanted}" is not in the archive for "${sourceName}". ` +
        `Available: ${sets.map((s) => s.layer).join(', ')}`,
    );
  }
  return found;
}

/** Reads the .cpg, falling back to UTF-8. */
export function readEncoding(cpgPath: string | null): { encoding: string; declared: boolean } {
  if (!cpgPath || !existsSync(cpgPath)) return { encoding: 'utf-8', declared: false };
  const raw = readFileSync(cpgPath, 'utf8').trim().toLowerCase();
  if (!raw) return { encoding: 'utf-8', declared: false };

  // Codepage spellings vary: "UTF-8", "utf8", "65001", "ISO-8859-1", "1252".
  const normalised = raw.replace(/\s+/g, '');
  if (/^(utf-?8|65001)$/.test(normalised)) return { encoding: 'utf-8', declared: true };
  if (/^(1252|cp1252|windows-?1252)$/.test(normalised)) return { encoding: 'windows-1252', declared: true };
  if (/^(8859|iso-?8859-?1|latin1)$/.test(normalised)) return { encoding: 'iso-8859-1', declared: true };
  return { encoding: raw, declared: true };
}

export interface CrsDecision {
  /** proj4 source definition -- WKT from the .prj, or an EPSG string. */
  definition: string;
  /** Human description for logs and provenance. */
  description: string;
  /** True when coordinates are already lon/lat and no transform is needed. */
  isGeographic: boolean;
  /** Set when the .prj disagrees with the registry's recorded SRID. */
  disagreement: string | null;
}

/** A metre or so on the ground. Below this, two CRS definitions are the same one. */
const CRS_AGREEMENT_TOLERANCE_DEG = 1e-5;

/**
 * Decides which CRS to read the geometry in, preferring the file's own .prj.
 *
 * Agreement with the registry is checked numerically rather than by comparing WKT text:
 * the same projection is written a dozen different ways ("PCS_Lambert_Conformal_Conic"
 * carries no EPSG code at all), so the only reliable comparison is to transform a point
 * with both and see whether they land in the same place.
 */
export function decideCrs(
  prjPath: string | null,
  registrySrid: number | null,
  sampleXY: [number, number],
  sourceName: string,
): CrsDecision {
  const wkt = prjPath && existsSync(prjPath) ? readFileSync(prjPath, 'utf8').trim() : null;

  if (!wkt) {
    if (registrySrid === null) {
      throw new ShapefileError(
        `The archive for "${sourceName}" has no .prj and the registry records no source_srid, ` +
          `so there is no way to know what its coordinates mean. Refusing to guess.`,
      );
    }
    return {
      definition: `EPSG:${registrySrid}`,
      description: `EPSG:${registrySrid} (from the registry; the archive has no .prj)`,
      isGeographic: registrySrid === 4326 || registrySrid === 4269,
      disagreement: null,
    };
  }

  let isGeographic: boolean;
  try {
    // proj4 accepts WKT1 directly. Probe it before trusting it.
    const probe = proj4(wkt, 'EPSG:4326', sampleXY);
    if (!Number.isFinite(probe[0]) || !Number.isFinite(probe[1])) {
      throw new Error('produced a non-finite coordinate');
    }
    isGeographic = /^GEOGCS/i.test(wkt);
  } catch (err) {
    throw new ShapefileError(
      `Could not interpret the .prj for "${sourceName}": ${err instanceof Error ? err.message : String(err)}. ` +
        `First 200 characters: ${wkt.slice(0, 200)}`,
    );
  }

  let disagreement: string | null = null;
  if (registrySrid !== null) {
    try {
      const fromPrj = proj4(wkt, 'EPSG:4326', sampleXY);
      const fromRegistry = proj4(`EPSG:${registrySrid}`, 'EPSG:4326', sampleXY);
      const delta = Math.max(
        Math.abs(fromPrj[0] - fromRegistry[0]),
        Math.abs(fromPrj[1] - fromRegistry[1]),
      );
      if (delta > CRS_AGREEMENT_TOLERANCE_DEG) {
        disagreement =
          `The archive's .prj disagrees with the registry's EPSG:${registrySrid} for "${sourceName}". ` +
          `A sample point lands at ${fromPrj.map((n) => n.toFixed(4)).join(', ')} per the .prj but ` +
          `${fromRegistry.map((n) => n.toFixed(4)).join(', ')} per the registry. Using the .prj, which is ` +
          `what the data was actually written in; the registry's source_srid should be corrected.`;
      }
    } catch {
      // An unknown registry SRID is not a reason to fail -- the .prj is authoritative and
      // already validated above.
      disagreement = `The registry records EPSG:${registrySrid} for "${sourceName}", which proj4 does not know. Using the .prj.`;
    }
  }

  return {
    definition: wkt,
    description: isGeographic ? 'geographic lon/lat (from the archive .prj)' : 'projected (from the archive .prj)',
    isGeographic,
    disagreement,
  };
}

export interface BulkRow extends IndexedRow {
  /** Tier B carries geometry from the start; Tier A fetches it lazily on export. */
  geometry: Geometry;
  vertexCount: number;
}

export interface ReadStats {
  /** Records in the file, including ones skipped below. */
  recordsSeen: number;
  /** Records whose bbox does not overlap Canada at all. */
  skippedOutsideCanada: number;
  /** Records with no geometry. Legal in the format, and not exportable. */
  skippedNullGeometry: number;
  /** Parts of kept multi-part features that lie outside Canada. See dropDistantParts. */
  droppedDistantParts: number;
}

export interface ReadOptions {
  set: ShapefileSet;
  crs: CrsDecision;
  encoding: string;
  /** Rows per yielded batch, so ingest can transact in chunks. */
  batchSize?: number;
  onProgress?: (rowsRead: number) => void;
  isCancelled?: () => boolean;
  /** Mutated as reading proceeds, since a generator cannot return a summary. */
  stats?: ReadStats;
}

export function emptyReadStats(): ReadStats {
  return { recordsSeen: 0, skippedOutsideCanada: 0, skippedNullGeometry: 0, droppedDistantParts: 0 };
}

/**
 * Drops the parts of a multi-part feature that lie nowhere near Canada.
 *
 * Aimed squarely at the global context layers. The United States polygon includes Hawaii
 * and American Samoa, 21 degrees SOUTH of the equator; Russia crosses the antimeridian.
 * Keeping those whole gives the feature a bounding box spanning -180..180 by -21..90,
 * which in an R-tree matches EVERY spatial query -- so a bbox search for a reserve in
 * Ontario would return Russia.
 *
 * This is part selection, not clipping: no vertex is moved and no new one invented, so
 * the parts that remain are exactly as published. The continental United States survives
 * intact, borders and all, because it genuinely touches Canada.
 */
export function dropDistantParts(geometry: Geometry): { geometry: Geometry | null; dropped: number } {
  if (geometry.type !== 'MultiPolygon' && geometry.type !== 'MultiLineString') {
    return { geometry, dropped: 0 };
  }

  const parts = geometry.coordinates as unknown[];
  const partType = geometry.type === 'MultiPolygon' ? 'Polygon' : 'LineString';
  const kept = parts.filter((part) => {
    const box = bboxOf({ type: partType, coordinates: part });
    return box === null || intersectsCanada(box);
  });

  /*
   * Null when no part is anywhere near Canada, rather than passing the feature through for
   * the caller to reject on its overall bbox.
   *
   * Russia is why. Natural Earth splits it at the antimeridian into 214 parts: 208 in
   * positive longitude across Siberia and the rest at -180..-169 in Chukotka. Not one of
   * them comes within 25 degrees of Canada, yet the union of their bounding boxes is
   * -180..180, which overlaps Canada and everywhere else on earth. Deciding per part and
   * reporting the emptiness directly is the only reading that gets this right.
   */
  if (kept.length === 0) return { geometry: null, dropped: parts.length };
  if (kept.length === parts.length) return { geometry, dropped: 0 };

  return {
    geometry: { type: geometry.type, coordinates: kept },
    dropped: parts.length - kept.length,
  };
}

/**
 * Strips DBF padding out of attribute values.
 *
 * The dBase format stores text in fixed-width fields. Most publishers pad with spaces,
 * which the reader trims, but some pad with NUL and those bytes come straight through:
 * Natural Earth's rivers give "Athabasca" followed by twenty U+0000, a 29-character
 * string. Left alone it becomes the official name, the search alias, and a run of
 * replacement boxes in the UI -- and it is written verbatim into an exported GeoJSON that
 * goes to air. Cleaned here, at the boundary, so nothing downstream has to know.
 */
export function cleanAttributes(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    // C0 controls, then surrounding whitespace. An empty result becomes null rather than
    // an empty string, so pickOfficialName treats it as absent and falls to the next field.
    // Matching control characters is the entire point here: they ARE the padding being
    // removed, so the rule that normally flags them does not apply.
    // eslint-disable-next-line no-control-regex
    const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    out[key] = cleaned === '' ? null : cleaned;
  }
  return out;
}

function countVertices(geometry: Geometry): number {
  let n = 0;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (c.length > 0 && typeof c[0] === 'number') {
      n++;
      return;
    }
    for (const child of c) visit(child);
  };
  visit(geometry.coordinates);
  return n;
}

/**
 * Builds the coordinate transform ONCE for the whole layer.
 *
 * Calling proj4(wktString, 'EPSG:4326', point) per coordinate re-parses several hundred
 * characters of WKT on every vertex. On the Elections Canada archive -- 343 ridings whose
 * .shp is 18.6 MB of coordinates -- that was the difference between 115 seconds and
 * roughly two. proj4's converter object does the parsing once and then just does maths.
 */
function makeTransform(definition: string): (p: number[]) => number[] {
  const converter = proj4(definition, 'EPSG:4326');
  return (p) => {
    const out = converter.forward([p[0] as number, p[1] as number]);
    return [out[0] as number, out[1] as number];
  };
}

function reproject(geometry: Geometry, convert: (p: number[]) => number[]): Geometry {
  const map = (c: unknown): unknown => {
    if (!Array.isArray(c)) return c;
    if (c.length > 0 && typeof c[0] === 'number') return convert(c as number[]);
    return c.map(map);
  };
  return { type: geometry.type, coordinates: map(geometry.coordinates) };
}

/**
 * Streams a shapefile as batches of indexed rows with geometry, already in EPSG:4326.
 *
 * The .shp is read as a stream rather than loaded whole: the Aboriginal Lands .shp is
 * 78 MB uncompressed and StatCan's dissemination areas are larger still.
 */
export async function* readLayer(opts: ReadOptions): AsyncGenerator<BulkRow[]> {
  const { set, crs, encoding } = opts;
  const batchSize = opts.batchSize ?? 500;

  if (!set.dbf) {
    throw new ShapefileError(
      `"${set.layer}" has no .dbf, so it carries geometry but no names or attributes. ` +
        `A nameless layer cannot be searched.`,
    );
  }

  let source: shapefile.ShapefileSource;
  try {
    source = await shapefile.open(set.shp, set.dbf, { encoding });
  } catch (err) {
    throw new ShapefileError(
      `Could not open ${basename(set.shp)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stats = opts.stats ?? emptyReadStats();
  const transform = crs.isGeographic ? null : makeTransform(crs.definition);
  let batch: BulkRow[] = [];
  let index = 0;

  try {
    for (;;) {
      if (opts.isCancelled?.()) break;

      const next = await source.read();
      if (next.done) break;

      const feature = next.value;
      index++;
      stats.recordsSeen = index;

      // A shapefile record with null geometry is legal and does happen. It cannot be
      // exported, so it is skipped rather than written as a feature with no shape.
      if (!feature?.geometry) {
        stats.skippedNullGeometry++;
        continue;
      }

      const raw: Geometry = feature.geometry;
      const projected = transform ? reproject(raw, transform) : raw;

      const trimmed = dropDistantParts(projected);
      if (!trimmed.geometry) {
        stats.skippedOutsideCanada++;
        continue;
      }
      stats.droppedDistantParts += trimmed.dropped;
      const geometry = trimmed.geometry;

      const bbox: Bbox | null = bboxOf(geometry);

      // Natural Earth's archives are world datasets: 1,300 lakes of which a handful are
      // Canadian. Anything that does not overlap Canada at all is dropped rather than
      // indexed with a null bbox, which would leave it searchable by name but invisible
      // to every spatial query. Intersection, not containment: the Great Lakes and the
      // United States straddle the border and are wanted as context.
      if (bbox && !intersectsCanada(bbox)) {
        stats.skippedOutsideCanada++;
        continue;
      }

      batch.push({
        // Shapefiles have no stable identifier of their own, so the record index is used.
        // Ingest overrides this with identity_field when the source declares one.
        sourceFeatureId: String(index),
        attributes: cleanAttributes(feature.properties ?? {}),
        bbox,
        geometry,
        vertexCount: countVertices(geometry),
      });

      if (batch.length >= batchSize) {
        opts.onProgress?.(index);
        yield batch;
        batch = [];
      }
    }

    if (batch.length > 0) {
      opts.onProgress?.(index);
      yield batch;
    }
  } finally {
    // Windows will not delete the extraction directory while these handles are open, and
    // the .shp/.dbf stay open until the source is cancelled -- including when the caller
    // breaks out of the loop early.
    await source.cancel().catch(() => undefined);
  }
}
