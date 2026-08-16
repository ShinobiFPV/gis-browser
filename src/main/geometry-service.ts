import { getDb } from '@db/index';
import { getCached, getFeatureWithSource, putCached } from '@db/geometry-cache';
import { HttpClient } from '../harvester/http';
import { fetchFeatureGeometry } from '../harvester/geometry';

/**
 * Lazy geometry resolution: cache first, network only on a miss, then cache permanently.
 *
 * Runs in main rather than the harvester utilityProcess because it is interactive -- the
 * artist has clicked a candidate and is waiting. The harvester is for bulk indexing and
 * may be mid-run; a preview must not queue behind 57,000 dissemination areas.
 */

export interface GeometryResult {
  geometry: unknown;
  vertexCount: number;
  bbox: [number, number, number, number] | null;
  fromCache: boolean;
  fetchMs: number;
  partCount: number;
  attribution: string | null;
  generalisationDeg: number | null;
}

const http = new HttpClient({
  // A single interactive fetch, not a bulk crawl: fail fast rather than making someone on
  // deadline watch four retries. Two attempts also matters for the generalisation ladder
  // -- when a service 500s because a geometry is too big to serialise, retrying at the
  // same resolution just burns another 20 seconds before the step-down that will work.
  timeoutMs: 60_000,
  maxAttempts: 2,
  log: (level, message) => {
    if (level === 'warn' || level === 'error') console.warn(`[geometry] ${message}`);
  },
});

/**
 * Requests for the same feature are coalesced. Double-clicking a candidate, or the
 * preview and export panes both asking at once, must not produce two downloads of the
 * same 200,000-vertex boundary.
 */
const inFlight = new Map<number, Promise<GeometryResult>>();

export function getGeometry(featureId: number): Promise<GeometryResult> {
  const existing = inFlight.get(featureId);
  if (existing) return existing;

  const task = resolve(featureId).finally(() => inFlight.delete(featureId));
  inFlight.set(featureId, task);
  return task;
}

async function resolve(featureId: number): Promise<GeometryResult> {
  const db = getDb();
  const started = Date.now();

  const cached = getCached(db, featureId);
  if (cached) {
    return {
      geometry: cached.geometry,
      vertexCount: cached.vertexCount,
      bbox: bboxOfFeature(featureId),
      fromCache: true,
      fetchMs: Date.now() - started,
      partCount: 1,
      attribution: attributionOf(featureId),
      generalisationDeg: cached.generalisationDeg,
    };
  }

  const pair = getFeatureWithSource(db, featureId);
  if (!pair) throw new Error(`Feature ${featureId} is not in the catalog`);

  const { feature, source } = pair;
  const fetched = await fetchFeatureGeometry(http, source, feature.source_feature_id, (note) =>
    console.warn(`[geometry] ${note}`),
  );

  putCached(db, featureId, fetched.geometry, {
    vertexCount: fetched.vertexCount,
    sourceSrid: fetched.sourceSrid,
    generalisationDeg: fetched.generalisationDeg,
  });

  return {
    geometry: fetched.geometry,
    vertexCount: fetched.vertexCount,
    bbox: bboxOfFeature(featureId),
    fromCache: false,
    fetchMs: Date.now() - started,
    partCount: fetched.partCount,
    attribution: source.attribution,
    generalisationDeg: fetched.generalisationDeg,
  };
}

function bboxOfFeature(featureId: number): [number, number, number, number] | null {
  const row = getDb()
    .prepare('SELECT minx, miny, maxx, maxy FROM features WHERE id = ?')
    .get(featureId) as { minx: number | null; miny: number | null; maxx: number | null; maxy: number | null } | undefined;
  if (!row || row.minx === null || row.miny === null || row.maxx === null || row.maxy === null) return null;
  return [row.minx, row.miny, row.maxx, row.maxy];
}

function attributionOf(featureId: number): string | null {
  const row = getDb()
    .prepare('SELECT s.attribution FROM features f JOIN sources s ON s.id = f.source_id WHERE f.id = ?')
    .get(featureId) as { attribution: string | null } | undefined;
  return row?.attribution ?? null;
}
