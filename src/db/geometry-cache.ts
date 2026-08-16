import { createHash } from 'node:crypto';
import type { Db } from './index';
import type { FeatureRow, SourceRow } from '@shared/types';

/**
 * The geometry cache.
 *
 * Tier A sources are indexed without geometry, so the first time an artist looks at a
 * boundary we fetch it and keep it here permanently. The cache warms naturally around
 * whatever the newsroom actually uses, which is the whole point of not mirroring
 * tens of gigabytes of Canada up front.
 */

export interface CachedGeometry {
  featureId: number;
  geometry: unknown;
  vertexCount: number;
  sourceSrid: number | null;
  contentHash: string;
  cachedAt: string;
  /** Degrees of source-side generalisation; null means full resolution. */
  generalisationDeg: number | null;
}

export function contentHashOf(geometryJson: string): string {
  return createHash('sha256').update(geometryJson).digest('hex');
}

export function getCached(db: Db, featureId: number): CachedGeometry | null {
  const row = db
    .prepare(
      `SELECT feature_id, geometry_json, vertex_count, source_srid, content_hash, cached_at, generalisation_deg
       FROM geometries WHERE feature_id = ?`,
    )
    .get(featureId) as
    | {
        feature_id: number;
        geometry_json: string;
        vertex_count: number | null;
        source_srid: number | null;
        content_hash: string | null;
        cached_at: string;
        generalisation_deg: number | null;
      }
    | undefined;

  if (!row) return null;
  return {
    featureId: row.feature_id,
    geometry: JSON.parse(row.geometry_json) as unknown,
    vertexCount: row.vertex_count ?? 0,
    sourceSrid: row.source_srid,
    contentHash: row.content_hash ?? '',
    cachedAt: row.cached_at,
    generalisationDeg: row.generalisation_deg,
  };
}

export function putCached(
  db: Db,
  featureId: number,
  geometry: unknown,
  opts: { vertexCount: number; sourceSrid: number | null; generalisationDeg: number | null },
): CachedGeometry {
  const geometryJson = JSON.stringify(geometry);
  const hash = contentHashOf(geometryJson);
  const cachedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO geometries
       (feature_id, geometry_json, vertex_count, source_srid, content_hash, cached_at, generalisation_deg)
     VALUES
       (@feature_id, @geometry_json, @vertex_count, @source_srid, @content_hash, @cached_at, @generalisation_deg)
     ON CONFLICT(feature_id) DO UPDATE SET
       geometry_json      = excluded.geometry_json,
       vertex_count       = excluded.vertex_count,
       source_srid        = excluded.source_srid,
       content_hash       = excluded.content_hash,
       cached_at          = excluded.cached_at,
       generalisation_deg = excluded.generalisation_deg`,
  ).run({
    feature_id: featureId,
    geometry_json: geometryJson,
    vertex_count: opts.vertexCount,
    source_srid: opts.sourceSrid,
    content_hash: hash,
    cached_at: cachedAt,
    generalisation_deg: opts.generalisationDeg,
  });

  return {
    featureId,
    geometry,
    vertexCount: opts.vertexCount,
    sourceSrid: opts.sourceSrid,
    contentHash: hash,
    cachedAt,
    generalisationDeg: opts.generalisationDeg,
  };
}

/** A feature plus the source it came from -- everything the fetcher needs. */
export interface FeatureWithSource {
  feature: FeatureRow;
  source: SourceRow;
}

export function getFeatureWithSource(db: Db, featureId: number): FeatureWithSource | null {
  const feature = db.prepare('SELECT * FROM features WHERE id = ?').get(featureId) as FeatureRow | undefined;
  if (!feature) return null;
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(feature.source_id) as SourceRow | undefined;
  if (!source) return null;
  return { feature, source };
}

export function cacheStats(db: Db): { cached: number; totalVertices: number } {
  const row = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(vertex_count), 0) v FROM geometries').get() as {
    n: number;
    v: number;
  };
  return { cached: row.n, totalVertices: row.v };
}
