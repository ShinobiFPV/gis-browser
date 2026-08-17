import { type HttpClient, HttpError, ServiceError, qs } from './http';
import { layerUrl } from './catalogs/esri-rest';
import { describeFeatureType, pickIdField } from './catalogs/ogc-wfs';
import {
  bboxOf,
  countVertices,
  looksAxisSwapped,
  mergeGeometries,
  swapAxes,
  toWgs84,
  withinCanada,
  type Geometry,
} from './normalize/crs';

// Re-exported so callers and tests keep importing it from the fetcher that made it
// necessary. It moved to normalize/crs so the mobile build can reach it without dragging
// the node-only HTTP client along; see the note there.
export { mergeGeometries };
import type { SourceRow } from '@shared/types';

/**
 * Full-geometry fetch for one feature -- the lazy half of "index everything, fetch
 * geometry on demand".
 *
 * The index pass deliberately threw away a generalised shape it only wanted a bbox from.
 * This is where the real, full-resolution boundary is retrieved, once, and handed to the
 * cache to keep permanently.
 */

export interface FetchedGeometry {
  geometry: Geometry;
  vertexCount: number;
  sourceSrid: number | null;
  /** How many separate parts the service returned before merging. */
  partCount: number;
  /**
   * Degrees of source-side generalisation applied to get a usable response.
   * null means full resolution, which is what we always try first.
   */
  generalisationDeg: number | null;
}

/**
 * Fallback ladder for boundaries a service cannot deliver whole.
 *
 * Nunavut's coastline in the StatCan cartographic boundary file 500s at full resolution
 * after roughly twenty seconds, every time, and succeeds as soon as it is generalised.
 * A coarser Nunavut is far more useful to an artist than an error, so we step down --
 * but we record how far, because a generalised boundary going to air is a fact about
 * that boundary and the UI has to be able to say so.
 *
 * Values are degrees in the output SR (4326). 0.0005° is roughly 40 m of latitude.
 */
const GENERALISATION_LADDER: (number | null)[] = [null, 0.0005, 0.002, 0.01];

/**
 * Validates and normalises whatever a service handed back.
 * A boundary that is not in Canada means an unhandled CRS, and shipping it would put a
 * wrong shape on air, so it throws rather than being stored.
 */
function finalise(
  parts: Geometry[],
  sourceSrid: number | null,
  context: string,
  generalisationDeg: number | null = null,
): FetchedGeometry {
  if (parts.length === 0) throw new Error(`${context}: service returned no geometry`);

  const merged = mergeGeometries(parts);
  const bbox = bboxOf(merged);
  if (!bbox) throw new Error(`${context}: geometry has no usable coordinates`);

  const check = withinCanada(bbox);
  if (!check.ok) {
    throw new Error(
      `${context}: geometry is outside Canada (${check.reason}). This almost always means an ` +
        `unhandled CRS -- refusing to cache it.`,
    );
  }

  return {
    geometry: merged,
    vertexCount: countVertices(merged),
    sourceSrid,
    partCount: parts.length,
    generalisationDeg,
  };
}

interface GeoJsonResponse {
  features?: { geometry?: Geometry | null }[];
  error?: { code?: number; message?: string };
}

/**
 * ESRI: `objectIds=` for a plain feature, or a where-clause on the identity field when
 * the layer is multipart. Elections Canada's 2025 layer really does publish one row per
 * polygon, so asking for a single OBJECTID there would return a fragment of a riding.
 */
async function fetchEsri(
  http: HttpClient,
  source: SourceRow,
  sourceFeatureId: string,
  onNote?: (note: string) => void,
): Promise<FetchedGeometry> {
  if (!source.layer_id) throw new Error(`ESRI source "${source.name}" has no layer_id`);

  const identity = source.identity_field;
  const context = `${source.name} feature ${sourceFeatureId}`;

  const attempt = async (offset: number | null): Promise<FetchedGeometry> => {
    const params: Record<string, string | number | boolean | undefined> = {
      outFields: source.identity_field ?? 'OBJECTID',
      returnGeometry: true,
      outSR: 4326,
      f: 'geojson',
      maxAllowableOffset: offset ?? undefined,
    };
    if (identity) {
      // Quote only when the value is not numeric; ESRI is strict about this.
      const literal = /^-?\d+(\.\d+)?$/.test(sourceFeatureId)
        ? sourceFeatureId
        : `'${sourceFeatureId.replace(/'/g, "''")}'`;
      params['where'] = `${identity}=${literal}`;
    } else {
      params['objectIds'] = sourceFeatureId;
    }

    const url = `${layerUrl(source.endpoint, source.layer_id!)}/query?${qs(params)}`;
    const body = await http.getJson<GeoJsonResponse>(url);
    if (body.error) throw new ServiceError(url, `${body.error.code ?? ''} ${body.error.message ?? ''}`.trim());

    const parts = (body.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => Boolean(g));
    // outSR=4326 was requested, so this is already lon/lat.
    return finalise(parts, source.source_srid, context, offset);
  };

  let lastError: unknown;
  for (const offset of GENERALISATION_LADDER) {
    try {
      const result = await attempt(offset);
      if (offset !== null) {
        onNote?.(
          `${context}: full resolution failed, served generalised at ${offset}° ` +
            `(${result.vertexCount.toLocaleString()} vertices)`,
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      // Only a service-side capacity failure is worth stepping down for. A 404, a bad
      // field name or geometry outside Canada will fail identically at every offset.
      if (!isCapacityFailure(err)) throw err;
    }
  }
  throw lastError instanceof Error
    ? new Error(`${context}: failed even at the coarsest generalisation -- ${lastError.message}`)
    : new Error(`${context}: failed even at the coarsest generalisation`);
}

/**
 * True when a failure looks like "the service could not build this response", which is
 * what an oversized geometry produces: a 5xx, or a timeout.
 */
function isCapacityFailure(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 0 || err.status >= 500;
  if (err instanceof ServiceError) return /error performing query|timeout|too large/i.test(err.message);
  return false;
}

/**
 * Builds an OGC Filter Encoding 2.0 document for one attribute equality test.
 * Standard FE rather than GeoServer's `cql_filter` vendor parameter, so this keeps
 * working against a non-GeoServer WFS.
 */
export function buildFesFilter(field: string, value: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">` +
    `<fes:PropertyIsEqualTo>` +
    `<fes:ValueReference>${esc(field)}</fes:ValueReference>` +
    `<fes:Literal>${esc(value)}</fes:Literal>` +
    `</fes:PropertyIsEqualTo>` +
    `</fes:Filter>`
  );
}

/**
 * Which attribute the index keyed on for a WFS type.
 *
 * The harvester picks this from DescribeFeatureType rather than trusting gml:id, because
 * GeoServer mints synthetic ids per request for primary-key-less views. The fetcher has
 * to key on the same attribute or it cannot find the feature again -- so it asks the same
 * question of the same schema and gets the same answer. Cached per process; one extra
 * request the first time a type is used in a session.
 */
const idFieldCache = new Map<string, string | null>();

async function wfsIdField(http: HttpClient, source: SourceRow): Promise<string | null> {
  const key = `${source.endpoint}|${source.layer_id ?? ''}`;
  const cached = idFieldCache.get(key);
  if (cached !== undefined) return cached;

  const props = await describeFeatureType(http, source.endpoint, source.layer_id!);
  const field = pickIdField(props);
  idFieldCache.set(key, field);
  return field;
}

async function fetchWfs(http: HttpClient, source: SourceRow, sourceFeatureId: string): Promise<FetchedGeometry> {
  if (!source.layer_id) throw new Error(`WFS source "${source.name}" has no typeName`);
  const srid = source.source_srid;
  if (!srid) throw new Error(`WFS source "${source.name}" has no source_srid recorded`);

  const params: Record<string, string | number> = {
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    typeNames: source.layer_id,
    outputFormat: 'application/json',
    srsName: `EPSG:${srid}`,
  };

  // Key on whatever attribute the index used. `identity_field` (multipart merging) wins
  // when set; otherwise recompute the same id attribute the harvester chose.
  const idField = source.identity_field ?? (await wfsIdField(http, source));
  if (idField) {
    params['filter'] = buildFesFilter(idField, sourceFeatureId);
  } else if (sourceFeatureId.includes('.')) {
    // No id attribute exists, so the index fell back to a real gml:id of the form
    // <typeName>.<pk>. Those are stable when the layer has a primary key.
    params['featureID'] = sourceFeatureId;
  } else {
    throw new Error(
      `WFS source "${source.name}" has no id attribute and feature id "${sourceFeatureId}" is not a gml:id`,
    );
  }

  const url = `${source.endpoint}?${qs(params)}`;
  const body = await http.getJson<GeoJsonResponse>(url);

  const raw = (body.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => Boolean(g));
  const converted = raw.map((g) => {
    let geom = g;
    const b = bboxOf(geom);
    if (b && srid === 4326 && looksAxisSwapped(b)) geom = swapAxes(geom);
    return toWgs84(geom, srid, `${source.name} geometry`);
  });

  return finalise(converted, srid, `${source.name} feature ${sourceFeatureId}`);
}

export async function fetchFeatureGeometry(
  http: HttpClient,
  source: SourceRow,
  sourceFeatureId: string,
  onNote?: (note: string) => void,
): Promise<FetchedGeometry> {
  switch (source.kind) {
    case 'esri-rest':
      return fetchEsri(http, source, sourceFeatureId, onNote);
    case 'wfs':
      return fetchWfs(http, source, sourceFeatureId);
    case 'bulk-file':
      throw new Error(
        `"${source.name}" is Tier B: its geometry arrives with the bulk download, which is M6. ` +
          `There is nothing to fetch per feature.`,
      );
    default:
      throw new Error(`Cannot fetch geometry from a "${source.kind}" source`);
  }
}
