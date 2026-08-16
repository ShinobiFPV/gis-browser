import type { Db } from './index';
import type { SourceRow, SourceStatus } from '@shared/types';

export function listSources(db: Db): SourceRow[] {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM features f WHERE f.source_id = s.id) AS indexed_count
       FROM sources s
       ORDER BY
         CASE s.feature_type
           WHEN 'federal_electoral_district' THEN 0
           WHEN 'provincial_electoral_district' THEN 1
           WHEN 'indian_reserve' THEN 2
           ELSE 3
         END,
         s.jurisdiction, s.name`,
    )
    .all() as SourceRow[];
}

export function getSource(db: Db, id: number): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
}

export function setSourceStatus(db: Db, id: number, status: SourceStatus): void {
  db.prepare('UPDATE sources SET status = ? WHERE id = ?').run(status, id);
}

export function recordHarvestResult(
  db: Db,
  id: number,
  opts: { featureCount: number; status: SourceStatus },
): void {
  db.prepare('UPDATE sources SET feature_count = ?, status = ?, last_harvested_at = ? WHERE id = ?').run(
    opts.featureCount,
    opts.status,
    new Date().toISOString(),
    id,
  );
}

export function getCachedGeometry(db: Db, featureId: number): { geometry_json: string; vertex_count: number | null } | undefined {
  return db.prepare('SELECT geometry_json, vertex_count FROM geometries WHERE feature_id = ?').get(featureId) as
    | { geometry_json: string; vertex_count: number | null }
    | undefined;
}

/** Counts used by the Sources pane header. */
export function catalogStats(db: Db): { sources: number; features: number; geometries: number; aliases: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    sources: one('SELECT COUNT(*) AS n FROM sources'),
    features: one('SELECT COUNT(*) AS n FROM features'),
    geometries: one('SELECT COUNT(*) AS n FROM geometries'),
    aliases: one('SELECT COUNT(*) AS n FROM aliases'),
  };
}
