import { type HttpClient, ServiceError, qs } from '../http';
import { asFeatureId } from '@shared/scalar';
import { bboxOf, looksAxisSwapped, swapAxes, toWgs84, type Bbox, type Geometry } from '../normalize/crs';
import type { IndexedRow } from './esri-rest';

/**
 * OGC WFS client.
 *
 * Axis order is the trap here. WFS 2.0 says geographic CRS use the authority's axis
 * order, which for EPSG:4326 is lat,lon -- but GeoServer special-cases GeoJSON output,
 * and different deployments disagree. Rather than guess, we request the source's own
 * PROJECTED CRS (easting,northing is unambiguous everywhere) and reproject with proj4
 * ourselves. A swap check still runs afterwards as a backstop, because a source that
 * ignores srsName would otherwise write mirrored boundaries into the catalog.
 */

export interface WfsFeatureTypeMeta {
  typeName: string;
  title: string;
  defaultCrsSrid: number | null;
}

/** Parses just enough of GetCapabilities to confirm the type exists and read its CRS. */
export function parseCapabilities(xml: string, typeName: string): WfsFeatureTypeMeta | null {
  const blocks = xml.split(/<(?:wfs:)?FeatureType[\s>]/i).slice(1);
  for (const block of blocks) {
    const name = /<(?:wfs:)?Name>([^<]+)<\/(?:wfs:)?Name>/i.exec(block)?.[1]?.trim();
    if (!name) continue;
    // Capabilities may or may not carry the workspace prefix.
    const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const wantedBare = typeName.includes(':') ? typeName.slice(typeName.indexOf(':') + 1) : typeName;
    if (name !== typeName && bare !== wantedBare) continue;

    const title = /<(?:wfs:)?Title>([^<]*)<\/(?:wfs:)?Title>/i.exec(block)?.[1]?.trim() ?? name;
    const crs = /<(?:wfs:)?(?:DefaultCRS|DefaultSRS)>([^<]+)<\/(?:wfs:)?(?:DefaultCRS|DefaultSRS)>/i.exec(block)?.[1];
    const srid = crs ? Number(/(\d+)\s*$/.exec(crs.trim())?.[1] ?? NaN) : NaN;

    return { typeName: name, title, defaultCrsSrid: Number.isFinite(srid) ? srid : null };
  }
  return null;
}

export async function fetchCapabilities(
  http: HttpClient,
  endpoint: string,
  typeName: string,
): Promise<WfsFeatureTypeMeta> {
  const url = `${endpoint}?${qs({ service: 'WFS', request: 'GetCapabilities', version: '2.0.0' })}`;
  const xml = await http.getText(url);
  const meta = parseCapabilities(xml, typeName);
  if (!meta) {
    throw new ServiceError(url, `feature type "${typeName}" is not advertised in GetCapabilities`);
  }
  return meta;
}

export interface WfsProperty {
  name: string;
  localType: string;
}

interface DescribeResponse {
  featureTypes?: { properties?: WfsProperty[] }[];
}

/** DescribeFeatureType, used to pick a sort field and locate the geometry property. */
export async function describeFeatureType(
  http: HttpClient,
  endpoint: string,
  typeName: string,
): Promise<WfsProperty[]> {
  const url = `${endpoint}?${qs({
    service: 'WFS',
    request: 'DescribeFeatureType',
    version: '2.0.0',
    typeNames: typeName,
    outputFormat: 'application/json',
  })}`;
  const body = await http.getJson<DescribeResponse>(url);
  const props = body.featureTypes?.[0]?.properties;
  if (!props?.length) throw new ServiceError(url, 'DescribeFeatureType returned no properties');
  return props;
}

export function geometryPropertyOf(props: WfsProperty[]): string | null {
  return props.find((p) => p.localType === 'Geometry' || /geometry|surface|polygon|point|curve/i.test(p.localType))?.name ?? null;
}

/**
 * Picks the attribute to sort on.
 *
 * GeoServer refuses `startIndex` paging on a layer with no primary key -- it answers
 * "Cannot do natural order without a primary key" -- and most BC Data Catalogue layers
 * are exactly that kind of view. Paging without a stable sort would also silently return
 * overlapping or missing pages, so a source with nothing to sort on is a hard failure
 * rather than an unsorted harvest.
 */
export function pickSortField(props: WfsProperty[], preferred?: string): string {
  const names = props.map((p) => p.name);
  if (preferred && names.includes(preferred)) return preferred;

  const idField = pickIdField(props);
  if (idField) return idField;

  const scalar = props.find((p) => p.localType !== 'Geometry' && !/geometry|surface|polygon/i.test(p.localType));
  if (scalar) return scalar.name;

  throw new Error(
    `No sortable attribute found for WFS paging among [${names.join(', ')}]. ` +
      `Paging without a stable sort would duplicate or drop features.`,
  );
}

/**
 * Finds an attribute usable as a durable feature identity.
 *
 * This matters more than it looks. GeoServer only emits a real gml:id when the layer has
 * a primary key; for a view without one it mints a per-request synthetic id like
 * `...SVW.fid-2facf063_1a00bca33b3_-7451`. Keying features on that means every re-harvest
 * inserts a fresh copy of the entire layer -- 93 BC ridings became 186 rows the first time
 * this ran. So we key on a real attribute whenever the schema offers one.
 */
export function pickIdField(props: WfsProperty[]): string | null {
  const names = props.map((p) => p.name);
  return (
    names.find((n) => /^OBJECTID$/i.test(n)) ?? names.find((n) => /(^|_)(ID|GUID|FID|SYSID)$/i.test(n)) ?? null
  );
}

/** True for the synthetic ids GeoServer generates when a layer has no primary key. */
export function isSyntheticFid(id: string): boolean {
  return /\.fid-/i.test(id);
}

/** WFS equivalent of returnCountOnly. resultType=hits returns a count with no features. */
export async function fetchHits(http: HttpClient, endpoint: string, typeName: string): Promise<number> {
  const url = `${endpoint}?${qs({
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    typeNames: typeName,
    resultType: 'hits',
  })}`;
  const xml = await http.getText(url);
  const matched = /numberMatched\s*=\s*"(\d+)"/i.exec(xml)?.[1];
  if (!matched) {
    throw new ServiceError(url, `resultType=hits response carried no numberMatched: ${xml.slice(0, 200)}`);
  }
  return Number(matched);
}

export interface WfsPageOptions {
  endpoint: string;
  typeName: string;
  /** Requested explicitly so axis order is never in question. */
  requestSrid: number;
  nameFields: string[];
  /** Mandatory: GeoServer will not page a primary-key-less layer without it. */
  sortField: string;
  /** Included in propertyName so the bbox can still be derived. */
  geometryField: string | null;
  /** Attribute holding a durable identity. Null falls back to gml:id, which may churn. */
  idField: string | null;
  pageSize?: number;
  startOffset?: number;
  onPage?: (rows: IndexedRow[], nextOffset: number) => void | Promise<void>;
}

interface GeoJsonFeatureCollection {
  features?: {
    id?: string | number;
    properties?: Record<string, unknown> | null;
    geometry?: Geometry | null;
  }[];
  numberMatched?: number;
  numberReturned?: number;
}

/**
 * Pages a WFS feature type with count/startIndex.
 *
 * `propertyName` is limited to the declared name fields so an index pass does not drag
 * down every attribute of every row. The geometry still comes back -- WFS has no
 * generalisation parameter we can rely on across servers -- but it is used only for the
 * bbox and then discarded, exactly as in the ESRI client.
 */
export async function* pageFeatures(
  http: HttpClient,
  opts: WfsPageOptions,
): AsyncGenerator<IndexedRow[], void, void> {
  const pageSize = opts.pageSize ?? 1000;
  let offset = opts.startOffset ?? 0;
  let axisSwapDetected = false;

  // Index pass: sort field, declared name fields, and the geometry (needed for the bbox).
  // Everything else stays on the server.
  const propertyName = [
    opts.sortField,
    ...(opts.idField ? [opts.idField] : []),
    ...opts.nameFields,
    ...(opts.geometryField ? [opts.geometryField] : []),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(',');

  for (;;) {
    if (http.isCancelled) return;

    const url = `${opts.endpoint}?${qs({
      service: 'WFS',
      request: 'GetFeature',
      version: '2.0.0',
      typeNames: opts.typeName,
      outputFormat: 'application/json',
      srsName: `EPSG:${opts.requestSrid}`,
      propertyName,
      sortBy: opts.sortField,
      count: pageSize,
      startIndex: offset,
    })}`;

    const body = await http.getJson<GeoJsonFeatureCollection>(url);
    const feats = body.features ?? [];
    const rows: IndexedRow[] = [];

    for (const f of feats) {
      const props = f.properties ?? {};
      const id = (opts.idField ? props[opts.idField] : undefined) ?? f.id;
      if (id === undefined || id === null) {
        throw new ServiceError(url, 'feature has no gml:id and no configured id field');
      }
      if (!opts.idField && typeof id === 'string' && isSyntheticFid(id)) {
        throw new Error(
          `WFS type "${opts.typeName}" has no stable identity attribute and the server is issuing ` +
            `synthetic feature ids (${id}). Re-harvesting would duplicate every feature. ` +
            `Declare an id attribute for this source before harvesting it.`,
        );
      }

      let bbox: Bbox | null = null;
      if (f.geometry) {
        let geom = f.geometry;

        // Backstop: if the server ignored srsName and handed back degrees in the wrong
        // order, the bbox is unmistakable. Fix it once and say so, loudly.
        const rawBbox = bboxOf(geom);
        if (rawBbox && opts.requestSrid === 4326 && looksAxisSwapped(rawBbox)) {
          geom = swapAxes(geom);
          if (!axisSwapDetected) {
            axisSwapDetected = true;
            console.warn(`[wfs] axis order flip detected for ${opts.typeName}; swapping lat/lon`);
          }
        }

        const wgs = toWgs84(geom, opts.requestSrid, `WFS ${opts.typeName}`);
        bbox = bboxOf(wgs);
      }

      rows.push({ sourceFeatureId: asFeatureId(id, `${url} feature id`), attributes: props, bbox });
    }

    offset += feats.length;

    if (rows.length > 0) {
      yield rows;
      if (opts.onPage) await opts.onPage(rows, offset);
    }

    if (feats.length === 0) return;
    if (feats.length < pageSize) return;
  }
}
