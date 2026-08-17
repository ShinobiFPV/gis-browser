import {
  bboxOf,
  countVertices,
  mergeGeometries,
  swapAxes,
  toWgs84,
  type Bbox,
  type Geometry,
} from '../../harvester/normalize/crs';
import { loadWorldPack, type MobileFeature } from './catalog';

/**
 * Geometry, fetched from the source service by the phone itself.
 *
 * The desktop reaches its services through harvester/http.ts, which cannot come along: it
 * writes downloads to disk and hashes them with node:crypto, so importing it would pull
 * node:fs into a browser bundle. What it does for a bulk harvest is also not what is wanted
 * here -- a phone makes one interactive request for one boundary somebody is waiting on.
 *
 * So the transport is local and small, and the four rules that actually matter on this path
 * are kept:
 *
 *   - every request has a timeout, and it is short, because someone is waiting
 *   - a service that answers an error with HTTP 200 is a failure, not a success
 *   - a boundary that cannot be delivered whole is retried generalised, and the fact is
 *     recorded rather than hidden
 *   - geometry that does not land where the index says the feature is, is never returned
 *
 * The last one replaces the desktop's withinCanada envelope check. That check is right for
 * a Canadian harvest and wrong here -- the catalog now covers every country, and rejecting
 * a boundary for being outside Canada would reject most of the world. Checking against the
 * feature's own indexed bbox catches the same class of bug (an unhandled CRS, an axis flip)
 * and catches it everywhere.
 */

export interface MobileGeometry {
  geometry: Geometry;
  vertexCount: number;
  partCount: number;
  bbox: [number, number, number, number] | null;
  /**
   * Degrees of generalisation the SOURCE applied because it could not serve the boundary
   * whole. null means full resolution.
   */
  generalisationDeg: number | null;
  /** True when this came from the bundled country pack rather than the network. */
  fromPack: boolean;
  fetchMs: number;
}

/** A single interactive fetch. Long enough for a big riding, short enough to not feel dead. */
const TIMEOUT_MS = 30_000;

/**
 * Fallback ladder, same values as the desktop's. Nunavut's coastline in the StatCan
 * cartographic boundary file 500s at full resolution every time and succeeds as soon as it
 * is generalised; a coarser Nunavut beats an error, as long as the app says which it got.
 */
const GENERALISATION_LADDER: (number | null)[] = [null, 0.0005, 0.002, 0.01];

class FetchFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FetchFailure';
  }
}

/** Builds a query string without the encodeURIComponent noise at every call site. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

/**
 * GETs JSON, turning the two failures a browser reports badly into ones that can be acted
 * on.
 *
 * A cross-origin block and an unplugged phone are the SAME exception here -- a bare
 * `TypeError: Failed to fetch`, with no status and no detail, because the browser will not
 * tell a page why a request it was not allowed to see failed. Guessing between them is the
 * best that can be done, and saying which was guessed is better than showing the artist a
 * message that explains nothing.
 */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    // The caller navigated away or changed feature. Not a failure worth describing.
    if (signal?.aborted) throw new Error('cancelled', { cause: err });
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchFailure(0, `the service did not answer within ${TIMEOUT_MS / 1000}s`, { cause: err });
    }
    throw new FetchFailure(
      0,
      navigator.onLine
        ? `the browser could not reach ${new URL(url).host}. Either the service is down, or it ` +
          `sent no CORS headers -- a page cannot read a response it was not given permission to read.`
        : 'this device is offline. Search still works; fetching a boundary does not.',
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new FetchFailure(res.status, `HTTP ${res.status} ${res.statusText}`.trim());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FetchFailure(0, `the service answered with something that is not JSON: ${text.slice(0, 120)}`);
  }
  return parsed as T;
}

interface GeoJsonResponse {
  features?: { geometry?: Geometry | null }[];
  error?: { code?: number; message?: string };
}

/**
 * True when a failure looks like "the service could not build this response", which is what
 * an oversized geometry produces. A 404 or a bad field name fails identically at every
 * offset, so stepping the ladder for those would just be three more ways to wait.
 */
function isCapacityFailure(err: unknown): boolean {
  if (err instanceof FetchFailure) return err.status === 0 || err.status >= 500;
  return /error performing query|timeout|too large/i.test(err instanceof Error ? err.message : '');
}

/**
 * Rejects geometry that did not land where the index says the feature is.
 *
 * The tolerance is deliberately loose. Generalisation pulls vertices inward, the indexed
 * bbox was itself derived from a generalised shape and padded, and a feature crossing the
 * antimeridian has a wrapped extent that no simple comparison describes. This is not a
 * precision test -- it is asking whether the returned shape is on the same part of the
 * planet, which is exactly the question an unhandled CRS or a flipped axis gets wrong.
 */
function overlapsIndexedExtent(fetched: Bbox, indexed: [number, number, number, number]): boolean {
  const [minx, miny, maxx, maxy] = indexed;
  // A wrapped extent is measured the long way round; every check below would be inverted.
  if (minx > maxx) return true;

  const slack = 1;
  return !(
    fetched.maxx < minx - slack ||
    fetched.minx > maxx + slack ||
    fetched.maxy < miny - slack ||
    fetched.miny > maxy + slack
  );
}

function finalise(
  parts: Geometry[],
  feature: MobileFeature,
  generalisationDeg: number | null,
  startedAt: number,
  fromPack: boolean,
): MobileGeometry {
  if (parts.length === 0) throw new Error(`${feature.name}: the service returned no geometry`);

  const merged = mergeGeometries(parts);
  const bbox = bboxOf(merged);
  if (!bbox) throw new Error(`${feature.name}: the geometry has no usable coordinates`);

  if (feature.bbox && !overlapsIndexedExtent(bbox, feature.bbox)) {
    throw new Error(
      `${feature.name}: the boundary came back at ${bbox.minx.toFixed(2)},${bbox.miny.toFixed(2)} but the ` +
        `index places it at ${feature.bbox[0].toFixed(2)},${feature.bbox[1].toFixed(2)}. That almost always ` +
        `means an unhandled coordinate system -- refusing to show it.`,
    );
  }

  return {
    geometry: merged,
    vertexCount: countVertices(merged),
    partCount: parts.length,
    bbox: [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy],
    generalisationDeg,
    fromPack,
    fetchMs: Math.round(performance.now() - startedAt),
  };
}

/** `.../MapServer` plus a layer id, matching what the harvester built the index from. */
function layerUrl(endpoint: string, layerId: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${layerId}`;
}

async function fetchEsri(feature: MobileFeature, startedAt: number, signal?: AbortSignal): Promise<MobileGeometry> {
  const { source } = feature;
  if (!source.layerId) throw new Error(`"${source.name}" has no layer id, so there is nothing to query`);

  const attempt = async (offset: number | null): Promise<MobileGeometry> => {
    const params: Record<string, string | number | boolean | undefined> = {
      outFields: source.identityField ?? 'OBJECTID',
      returnGeometry: true,
      outSR: 4326,
      f: 'geojson',
      maxAllowableOffset: offset ?? undefined,
    };

    if (source.identityField) {
      // A multipart layer publishes one row per polygon, so asking for a single object id
      // would return a fragment of a riding -- and it would look like a riding.
      const literal = /^-?\d+(\.\d+)?$/.test(feature.sourceFeatureId)
        ? feature.sourceFeatureId
        : `'${feature.sourceFeatureId.replace(/'/g, "''")}'`;
      params['where'] = `${source.identityField}=${literal}`;
    } else {
      params['objectIds'] = feature.sourceFeatureId;
    }

    const url = `${layerUrl(source.endpoint, source.layerId)}/query?${qs(params)}`;
    const body = await getJson<GeoJsonResponse>(url, signal);

    // ESRI answers errors with HTTP 200 and an error object. Treating that as success is
    // the silent-wrong-shape failure this whole app exists to prevent.
    if (body.error) {
      throw new FetchFailure(
        body.error.code ?? 0,
        `${source.name} refused the query: ${body.error.message ?? 'no reason given'}`,
      );
    }

    const parts = (body.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => Boolean(g));
    // outSR=4326 was asked for, so this is already lon/lat.
    return finalise(parts, feature, offset, startedAt, false);
  };

  let lastError: unknown;
  for (const offset of GENERALISATION_LADDER) {
    try {
      return await attempt(offset);
    } catch (err) {
      lastError = err;
      if (!isCapacityFailure(err)) throw err;
    }
  }
  throw new Error(
    `${feature.name}: the service could not deliver this boundary even at the coarsest generalisation -- ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Builds an OGC Filter Encoding 2.0 document for one attribute equality test. Standard FE
 * rather than GeoServer's `cql_filter` vendor parameter, so this keeps working against a
 * WFS that is not GeoServer.
 */
function buildFesFilter(field: string, value: string): string {
  const esc = (s: string): string =>
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
 * WFS.
 *
 * The desktop asks DescribeFeatureType which attribute the index keyed on, because
 * GeoServer mints synthetic gml:ids per request for primary-key-less views. A phone does
 * not: that is a second round trip on an interactive path, and the answer is already known
 * at index time. So the identity field travels in the index, and a source that has neither
 * an identity field nor a real gml:id fails with a message that says what is missing rather
 * than fetching the wrong feature.
 */
async function fetchWfs(feature: MobileFeature, startedAt: number, signal?: AbortSignal): Promise<MobileGeometry> {
  const { source } = feature;
  if (!source.layerId) throw new Error(`"${source.name}" has no typeName, so there is nothing to query`);
  if (!source.srid) throw new Error(`"${source.name}" has no recorded SRID, so its coordinates cannot be read`);

  const params: Record<string, string | number> = {
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    typeNames: source.layerId,
    outputFormat: 'application/json',
    srsName: `EPSG:${source.srid}`,
  };

  if (source.identityField) {
    params['filter'] = buildFesFilter(source.identityField, feature.sourceFeatureId);
  } else if (feature.sourceFeatureId.includes('.')) {
    params['featureID'] = feature.sourceFeatureId;
  } else {
    throw new Error(
      `"${source.name}" has no id attribute in the index and "${feature.sourceFeatureId}" is not a gml:id, ` +
        `so this feature cannot be requested by name. Rebuild the mobile index from a catalog that has one.`,
    );
  }

  const body = await getJson<GeoJsonResponse>(`${source.endpoint}?${qs(params)}`, signal);
  const raw = (body.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => Boolean(g));

  const converted = raw.map((g) => {
    let geom = g;
    const b = bboxOf(geom);
    // WFS 2.0 flips axis order on geographic CRS in a way that varies by deployment. The
    // indexed bbox is the reference: if the coordinates only make sense swapped, swap them.
    if (b && source.srid === 4326 && feature.bbox && !overlapsIndexedExtent(b, feature.bbox)) {
      const swapped = { minx: b.miny, miny: b.minx, maxx: b.maxy, maxy: b.maxx };
      if (overlapsIndexedExtent(swapped, feature.bbox)) geom = swapAxes(geom);
    }
    return toWgs84(geom, source.srid!, `${source.name} geometry`);
  });

  return finalise(converted, feature, null, startedAt, false);
}

/**
 * Countries come out of the bundled pack, not the network.
 *
 * Natural Earth's archive is on a host that sends no CORS headers, so a browser physically
 * cannot fetch it. Their geometry is simplified at build time and shipped with the app
 * instead -- see scripts/build-world-pack.mjs.
 */
async function fromWorldPack(feature: MobileFeature, startedAt: number): Promise<MobileGeometry> {
  const pack = await loadWorldPack();
  const geometry = pack.get(feature.id);
  if (!geometry) {
    throw new Error(
      `"${feature.name}" is a country, but it is not in the bundled country pack. The pack and the ` +
        `index were built from different catalogs.`,
    );
  }
  return finalise([geometry], feature, null, startedAt, true);
}

/**
 * Fetched geometry, kept for the session.
 *
 * The desktop caches to SQLite permanently. This is only a Map, which is the honest scope:
 * a phone that reloads the page has thrown the boundary away, and pretending otherwise
 * would mean writing a storage layer whose eviction rules nobody has thought about. What it
 * does buy is that flipping between a preview and an export, or tapping the same riding
 * twice, costs one download rather than several.
 */
const cache = new Map<number, MobileGeometry>();
const inFlight = new Map<number, Promise<MobileGeometry>>();

export function cachedGeometry(featureId: number): MobileGeometry | null {
  return cache.get(featureId) ?? null;
}

export function getGeometry(feature: MobileFeature, signal?: AbortSignal): Promise<MobileGeometry> {
  const held = cache.get(feature.id);
  if (held) return Promise.resolve(held);

  // Double-tapping a result, or the preview and the export pane both asking at once, must
  // not produce two downloads of the same 200,000-vertex boundary.
  const running = inFlight.get(feature.id);
  if (running) return running;

  const startedAt = performance.now();
  const task = (async () => {
    if (feature.featureType === 'country') return fromWorldPack(feature, startedAt);
    switch (feature.source.kind) {
      case 'esri-rest':
      case 'arcgis-hub':
        return fetchEsri(feature, startedAt, signal);
      case 'wfs':
        return fetchWfs(feature, startedAt, signal);
      default:
        throw new Error(
          `"${feature.source.name}" is a ${feature.source.kind} source. Only services that answer per ` +
            `feature can be read from a phone.`,
        );
    }
  })()
    .then((result) => {
      cache.set(feature.id, result);
      return result;
    })
    .finally(() => inFlight.delete(feature.id));

  inFlight.set(feature.id, task);
  return task;
}
