import { qs, ServiceError, type HttpClient } from '../http';

/**
 * CKAN discovery.
 *
 * `/api/3/action/package_search` over the federal and provincial open-data portals. The
 * shape is uniform across instances; what varies wildly is what the resources point AT.
 *
 * Observed on the four seeded catalogs: open.canada.ca returns mostly PDF and JPG for
 * boundary searches, Alberta returns HTML landing pages, Ontario's CKAN holds almost no
 * boundary data at all (theirs lives on an ArcGIS Hub), and BC returns SHP downloads
 * alongside the WFS we already seed directly. So CKAN is treated as a way to find FILES
 * and occasional services, not as a peer of the Hub -- and every resource is classified by
 * what it actually is rather than by what its `format` field claims.
 */

export const GEOSPATIAL_FORMATS = ['esri rest', 'wfs', 'wms', 'geojson', 'shp', 'shapefile', 'kml', 'kmz', 'gpkg'];

export interface CkanResource {
  id: string | null;
  name: string | null;
  /** As declared by the publisher. Frequently wrong or absent. */
  format: string | null;
  url: string | null;
  description: string | null;
}

export interface CkanPackage {
  id: string;
  name: string;
  title: string;
  notes: string | null;
  organization: string | null;
  licence: string | null;
  licenceUrl: string | null;
  modified: string | null;
  resources: CkanResource[];
  tags: string[];
}

interface CkanEnvelope {
  success?: boolean;
  error?: { message?: string; __type?: string };
  result?: {
    count?: number;
    results?: Record<string, unknown>[];
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function toResource(raw: Record<string, unknown>): CkanResource {
  return {
    id: str(raw['id']),
    name: str(raw['name']),
    format: str(raw['format']),
    url: str(raw['url']),
    description: str(raw['description'])?.replace(/\s+/g, ' ').slice(0, 300) ?? null,
  };
}

function toPackage(raw: Record<string, unknown>): CkanPackage | null {
  const id = str(raw['id']);
  const name = str(raw['name']);
  const title = str(raw['title']) ?? name;
  if (!id || !name || !title) return null;

  const org = raw['organization'];
  const tags = Array.isArray(raw['tags'])
    ? (raw['tags'] as Record<string, unknown>[]).map((t) => str(t['display_name']) ?? str(t['name'])).filter((t): t is string => !!t)
    : [];

  return {
    id,
    name,
    title,
    notes: str(raw['notes'])?.replace(/\s+/g, ' ').slice(0, 500) ?? null,
    organization: org && typeof org === 'object' ? str((org as Record<string, unknown>)['title']) : null,
    licence: str(raw['license_title']),
    licenceUrl: str(raw['license_url']),
    modified: str(raw['metadata_modified']),
    resources: Array.isArray(raw['resources'])
      ? (raw['resources'] as Record<string, unknown>[]).map(toResource)
      : [],
    tags,
  };
}

/**
 * What a resource really is.
 *
 * The declared `format` is a hint, not an answer: BC labels a whole dataset "multiple",
 * plenty of publishers leave it blank, and a "GeoJSON" pointing at a landing page is
 * common. The URL is the stronger signal, so it is checked first.
 */
export function classifyResource(resource: CkanResource): 'esri-rest' | 'wfs' | 'bulk-file' | null {
  const url = (resource.url ?? '').toLowerCase();
  const format = (resource.format ?? '').toLowerCase();

  if (!url) return null;

  if (/\/rest\/services\/.*\/(feature|map)server/i.test(url)) return 'esri-rest';
  if (/service=wfs|\/wfs\b|\/geoserver\//i.test(url)) return 'wfs';
  if (/\.(zip|gpkg|geojson|json|shp)(\?|$)/i.test(url)) return 'bulk-file';

  // Fall back to the declared format only when the URL says nothing.
  if (format.includes('esri rest')) return 'esri-rest';
  if (format === 'wfs') return 'wfs';
  if (['shp', 'shapefile', 'geojson', 'gpkg'].includes(format)) return 'bulk-file';

  return null;
}

export interface CkanSearchOptions {
  q: string;
  rows?: number;
  maxPages?: number;
}

export interface CkanPage {
  packages: CkanPackage[];
  totalCount: number | null;
  start: number;
}

/** CKAN caps `rows` at 1000, but large pages time out on slower portals. */
export const DEFAULT_ROWS = 50;

export async function* searchPackages(
  http: HttpClient,
  apiRoot: string,
  opts: CkanSearchOptions,
): AsyncGenerator<CkanPage> {
  const rows = opts.rows ?? DEFAULT_ROWS;
  const maxPages = opts.maxPages ?? 4;

  for (let page = 0; page < maxPages; page++) {
    if (http.isCancelled) return;

    const start = page * rows;
    const url = `${apiRoot}/action/package_search?${qs({ q: opts.q, rows, start })}`;
    const body = await http.getJson<CkanEnvelope>(url);

    // CKAN answers errors with HTTP 200 and success:false, the same trap ESRI sets.
    if (body.success === false) {
      throw new ServiceError(url, body.error?.message ?? body.error?.__type ?? 'package_search failed');
    }

    const results = body.result?.results ?? [];
    const packages = results.map(toPackage).filter((p): p is CkanPackage => p !== null);

    yield { packages, totalCount: body.result?.count ?? null, start };

    if (results.length < rows) return;
  }
}
