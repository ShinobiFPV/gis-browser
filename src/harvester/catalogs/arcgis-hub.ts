import { sanitiseExtent, type LonLatBox } from '@shared/provinces';
import { qs, ServiceError, type HttpClient } from '../http';

/**
 * ArcGIS Hub discovery.
 *
 * `hub.arcgis.com/api/v3/datasets` is a JSON:API search over every dataset published to
 * any public ArcGIS Online organisation. Two facts about it shape everything here:
 *
 * It is global and enormous. A search for "electoral district" reports 657,212 matches,
 * almost all irrelevant -- American precincts, municipal wards, a Kingston city layer.
 * There is no server-side region filter (filter[region]=Canada returns nothing), so
 * narrowing to Canada is done here, against each result's own extent.
 *
 * The page size limit is 250, not the 100 the brief expected. The API says so itself:
 * "'page[size]=500' exceeds the maximum page size limit of 250". Asking for 101 succeeds
 * and returns 101, so the 100 figure is not enforced anywhere.
 */

export const HUB_API = 'https://hub.arcgis.com/api/v3';

/** Verified against the live API: 250 is accepted, 500 is a 400 naming this limit. */
export const MAX_PAGE_SIZE = 250;

export interface HubDataset {
  id: string;
  name: string;
  /** The ESRI REST layer endpoint. Null for datasets with no queryable service. */
  url: string | null;
  /** Publishing organisation, as it describes itself. */
  source: string | null;
  owner: string | null;
  /** 'Feature Layer', 'Map Service', 'Table', ... */
  type: string | null;
  recordCount: number | null;
  extent: LonLatBox | null;
  srid: number | null;
  fieldNames: string[];
  tags: string[];
  licence: string | null;
  description: string | null;
  modified: string | null;
}

interface HubEnvelope {
  data?: {
    id?: string;
    attributes?: Record<string, unknown>;
  }[];
  meta?: { stats?: { totalCount?: number } };
  links?: { next?: string };
  errors?: { title?: string; detail?: string }[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Hub extents are `{type:'envelope', coordinates:[[west,south],[east,north]]}`. */
export function parseExtent(raw: unknown): LonLatBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const coords = (raw as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const [sw, ne] = coords as [unknown, unknown];
  if (!Array.isArray(sw) || !Array.isArray(ne)) return null;

  const [minLon, minLat] = sw as [number, number];
  const [maxLon, maxLat] = ne as [number, number];
  if (![minLon, minLat, maxLon, maxLat].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (maxLon < minLon || maxLat < minLat) return null;

  // Hub extents are frequently an unset default spanning the planet. sanitiseExtent
  // turns those into null here, at the boundary, so nothing downstream mistakes a
  // world-sized box for evidence about where a dataset is.
  return sanitiseExtent({ minLon, minLat, maxLon, maxLat });
}

/**
 * Pulls an EPSG code out of serviceSpatialReference.
 *
 * `latestWkid` is preferred over `wkid` because ESRI reports Web Mercator as the
 * deprecated 102100 in `wkid` and the current 3857 in `latestWkid`.
 */
export function parseSrid(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const sr = raw as { latestWkid?: unknown; wkid?: unknown };
  for (const candidate of [sr.latestWkid, sr.wkid]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

export function toDataset(row: { id?: string; attributes?: Record<string, unknown> }): HubDataset | null {
  const a = row.attributes ?? {};
  const name = str(a['name']) ?? str(a['title']);
  if (!row.id || !name) return null;

  return {
    id: row.id,
    name,
    url: str(a['url']),
    source: str(a['source']),
    owner: str(a['owner']),
    type: str(a['type']),
    recordCount: typeof a['recordCount'] === 'number' ? a['recordCount'] : null,
    extent: parseExtent(a['extent']),
    srid: parseSrid(a['serviceSpatialReference']),
    fieldNames: strings(a['fieldNames']),
    tags: strings(a['tags']),
    // Hub reports licence as free text, often 'none' or 'custom', sometimes a block of
    // HTML. Tags stripped; the value is a hint for a human, never a licence of record.
    licence: str(a['license'])?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? null,
    description: str(a['description'])?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500) ?? null,
    modified: str(a['itemModified']) ?? str(a['modified']),
  };
}

export interface HubSearchOptions {
  q: string;
  pageSize?: number;
  /** Hard cap on pages walked. The result set is effectively unbounded otherwise. */
  maxPages?: number;
  /** e.g. { type: 'Feature Layer' } becomes filter[type]=Feature Layer. */
  filters?: Record<string, string>;
}

export interface HubPage {
  datasets: HubDataset[];
  totalCount: number | null;
  pageNumber: number;
}

/**
 * Walks Hub search results page by page.
 *
 * Paging is by `page[number]` rather than by following `links.next`, so the caller's page
 * cap is enforced against a number we control instead of a URL the API hands back.
 */
export async function* searchDatasets(
  http: HttpClient,
  opts: HubSearchOptions,
  apiRoot = HUB_API,
): AsyncGenerator<HubPage> {
  const pageSize = Math.min(opts.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const maxPages = opts.maxPages ?? 4;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    if (http.isCancelled) return;

    const params: Record<string, string> = {
      q: opts.q,
      'page[size]': String(pageSize),
      'page[number]': String(pageNumber),
    };
    for (const [k, v] of Object.entries(opts.filters ?? {})) params[`filter[${k}]`] = v;

    const url = `${apiRoot}/datasets?${qs(params)}`;
    const body = await http.getJson<HubEnvelope>(url);

    if (body.errors?.length) {
      throw new ServiceError(url, body.errors.map((e) => e.detail ?? e.title ?? '?').join('; '));
    }

    const rows = body.data ?? [];
    const datasets = rows.map(toDataset).filter((d): d is HubDataset => d !== null);

    yield { datasets, totalCount: body.meta?.stats?.totalCount ?? null, pageNumber };

    // A short page is the end of the result set.
    if (rows.length < pageSize) return;
  }
}
