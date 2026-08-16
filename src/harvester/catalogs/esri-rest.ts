import { type HttpClient, ServiceError, qs } from '../http';
import { asFeatureId, asNumber, asText } from '@shared/scalar';
import { bboxOf, padBbox, type Bbox, type Geometry } from '../normalize/crs';

/**
 * ESRI REST (MapServer / FeatureServer) client.
 *
 * Indexing strategy, per the "index everything, fetch geometry on demand" rule:
 * we request the name fields plus a HEAVILY generalised geometry (`maxAllowableOffset`
 * in output-SR degrees). The generalised shape is used only to derive a bbox and is then
 * thrown away -- it is never written to the geometry cache. That keeps the index payload
 * small while still populating the R-tree, so "every reserve within this bbox" works
 * before any geometry has been fetched.
 *
 * Generalisation can only pull vertices inward, never outward, so the derived bbox is
 * padded by the offset to stay conservative.
 */

const INDEX_OFFSET_DEG = 0.005; // ~500 m at Canadian latitudes

export interface EsriField {
  name: string;
  type: string;
  alias?: string;
}

export interface EsriLayerMeta {
  name: string;
  geometryType: string;
  maxRecordCount: number;
  supportsPagination: boolean;
  objectIdField: string;
  fields: EsriField[];
  extentWkid: number | null;
}

interface EsriServiceError {
  error?: { code?: number; message?: string; details?: string[] };
}

function throwIfServiceError(url: string, body: unknown): void {
  const e = (body as EsriServiceError).error;
  if (e) {
    const detail = [e.code ? `code ${e.code}` : '', e.message ?? '', (e.details ?? []).join('; ')]
      .filter(Boolean)
      .join(' ');
    throw new ServiceError(url, detail || 'unspecified ESRI error');
  }
}

export function layerUrl(endpoint: string, layerId: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${layerId}`;
}

export async function fetchLayerMeta(http: HttpClient, endpoint: string, layerId: string): Promise<EsriLayerMeta> {
  const url = `${layerUrl(endpoint, layerId)}?f=json`;
  const body = await http.getJson<Record<string, unknown>>(url);
  throwIfServiceError(url, body);

  const extent = body['extent'] as { spatialReference?: { wkid?: number; latestWkid?: number } } | undefined;
  const advanced = body['advancedQueryCapabilities'] as { supportsPagination?: boolean } | undefined;

  const meta: EsriLayerMeta = {
    name: asText(body['name'], layerId),
    geometryType: asText(body['geometryType'], ''),
    maxRecordCount: asNumber(body['maxRecordCount'], 1000),
    supportsPagination: advanced?.supportsPagination ?? false,
    objectIdField: asText(body['objectIdField'], 'OBJECTID'),
    fields: Array.isArray(body['fields']) ? (body['fields'] as EsriField[]) : [],
    extentWkid: extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid ?? null,
  };

  if (!Number.isFinite(meta.maxRecordCount) || meta.maxRecordCount <= 0) meta.maxRecordCount = 1000;
  return meta;
}

/** The service's own authoritative row count. This is the reconciliation baseline. */
export async function fetchCount(http: HttpClient, endpoint: string, layerId: string): Promise<number> {
  const url = `${layerUrl(endpoint, layerId)}/query?${qs({ where: '1=1', returnCountOnly: true, f: 'json' })}`;
  const body = await http.getJson<{ count?: number }>(url);
  throwIfServiceError(url, body);
  if (typeof body.count !== 'number') {
    throw new ServiceError(url, `returnCountOnly did not include a count: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.count;
}

export interface IndexedRow {
  sourceFeatureId: string;
  attributes: Record<string, unknown>;
  bbox: Bbox | null;
}

interface EsriGeoJsonFeature {
  type: string;
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: Geometry | null;
}

interface EsriGeoJsonResponse {
  type?: string;
  features?: EsriGeoJsonFeature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

/**
 * Which fields to request. We ask for the declared name fields plus the OBJECTID and any
 * field the type-refinement rules need. Requesting `*` on a 57,000-row layer is what
 * makes an index harvest slow, so we do not.
 */
export function buildOutFields(meta: EsriLayerMeta, nameFields: string[]): string {
  const available = new Set(meta.fields.map((f) => f.name));
  const wanted = new Set<string>([meta.objectIdField]);

  for (const f of nameFields) if (available.has(f)) wanted.add(f);

  // Fields the taxonomy refinement and provenance need when the layer carries them.
  for (const extra of ['distributionTypeEng', 'jurisdictionEng', 'CMATYPE', 'PRUID', 'REP_ORDER', 'REPORDER']) {
    if (available.has(extra)) wanted.add(extra);
  }

  const list = [...wanted];
  // A source whose declared name fields are all missing is a registry bug, not a
  // recoverable condition -- surface it instead of harvesting nameless rows.
  const anyName = nameFields.some((f) => available.has(f));
  if (!anyName) {
    throw new Error(
      `None of the declared name fields [${nameFields.join(', ')}] exist on layer "${meta.name}". ` +
        `Available: ${[...available].join(', ')}`,
    );
  }
  return list.join(',');
}

export interface PageOptions {
  endpoint: string;
  layerId: string;
  meta: EsriLayerMeta;
  outFields: string;
  /** Where to resume from after an interrupted harvest. */
  startOffset?: number;
  /** Emitted after each page so the checkpoint can be written. */
  onPage?: (rows: IndexedRow[], nextOffset: number) => void | Promise<void>;
  /** Set false to skip the generalised-geometry bbox pass entirely. */
  withBbox?: boolean;
}

/**
 * Pages a layer to exhaustion.
 *
 * ESRI caps each response at `maxRecordCount` and signals more data with
 * `exceededTransferLimit`. We page on resultOffset/resultRecordCount and stop only when a
 * page comes back short AND the transfer-limit flag is clear -- trusting either signal
 * alone has bitten every ESRI client ever written.
 */
export async function* pageFeatures(http: HttpClient, opts: PageOptions): AsyncGenerator<IndexedRow[], void, void> {
  const { endpoint, layerId, meta, outFields } = opts;
  const withBbox = opts.withBbox ?? true;
  const pageSize = meta.maxRecordCount;
  let offset = opts.startOffset ?? 0;

  if (!meta.supportsPagination && offset > 0) {
    throw new Error(
      `Layer "${meta.name}" does not advertise pagination support but a resume offset of ${offset} was requested.`,
    );
  }

  for (;;) {
    if (http.isCancelled) return;

    const url =
      `${layerUrl(endpoint, layerId)}/query?` +
      qs({
        where: '1=1',
        outFields,
        returnGeometry: withBbox,
        // Generalise hard: we only want this geometry for its bounding box.
        maxAllowableOffset: withBbox ? INDEX_OFFSET_DEG : undefined,
        geometryPrecision: withBbox ? 4 : undefined,
        outSR: 4326,
        resultOffset: offset,
        resultRecordCount: pageSize,
        orderByFields: meta.objectIdField,
        f: 'geojson',
      });

    const body = await http.getJson<EsriGeoJsonResponse>(url);
    throwIfServiceError(url, body);

    const feats = body.features ?? [];
    const rows: IndexedRow[] = [];

    for (const f of feats) {
      const props = f.properties ?? {};
      const oid = props[meta.objectIdField] ?? f.id;
      if (oid === undefined || oid === null) {
        throw new ServiceError(url, `feature is missing its object id field "${meta.objectIdField}"`);
      }
      const sourceFeatureId = asFeatureId(oid, `${url} field "${meta.objectIdField}"`);
      let bbox: Bbox | null = null;
      if (f.geometry) {
        const raw = bboxOf(f.geometry);
        // outSR=4326 was requested, so anything here is already lon/lat.
        if (raw) bbox = padBbox(raw, INDEX_OFFSET_DEG);
      }
      rows.push({ sourceFeatureId, attributes: props, bbox });
    }

    const exceeded = body.exceededTransferLimit ?? body.properties?.exceededTransferLimit ?? false;
    offset += feats.length;

    if (rows.length > 0) {
      yield rows;
      if (opts.onPage) await opts.onPage(rows, offset);
    }

    // Stop only when the page was short and the service is not flagging more data.
    if (feats.length === 0) return;
    if (feats.length < pageSize && !exceeded) return;
    if (!meta.supportsPagination) {
      throw new Error(
        `Layer "${meta.name}" returned ${feats.length} rows with more available but does not support ` +
          `pagination, so the remainder is unreachable. Harvest would be silently truncated.`,
      );
    }
  }
}

/** Lazy geometry fetch for one feature, used by M2's cache fill. */
export async function fetchGeometry(
  http: HttpClient,
  endpoint: string,
  layerId: string,
  objectId: string,
): Promise<Geometry | null> {
  const url =
    `${layerUrl(endpoint, layerId)}/query?` +
    qs({ objectIds: objectId, outFields: '', returnGeometry: true, outSR: 4326, f: 'geojson' });
  const body = await http.getJson<EsriGeoJsonResponse>(url);
  throwIfServiceError(url, body);
  const first = body.features?.[0];
  return first?.geometry ?? null;
}
