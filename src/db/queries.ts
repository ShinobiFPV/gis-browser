import type { Db } from './index';
import { CANADA_SUBDIVISION_LABELS } from '@shared/jurisdictions';
import type { JurisdictionOption, SourceRow, SourceStatus } from '@shared/types';

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

/**
 * Every jurisdiction that actually has features indexed, with its label and count.
 *
 * Driven off `features` rather than the `jurisdictions` registry so the filter can only
 * offer codes that can return something. A registry row exists as soon as a country is
 * harvested, but a dropdown entry that always yields nothing is worse than no entry.
 *
 * `label` falls back to the bare code, which is what an un-registered code looks like --
 * visible rather than silently blank.
 */

export function listJurisdictions(db: Db): JurisdictionOption[] {
  return db
    .prepare(
      `SELECT f.jurisdiction AS code,
              COALESCE(j.label, f.jurisdiction) AS label,
              COALESCE(j.kind, CASE WHEN LENGTH(f.jurisdiction) = 2 THEN 'country' ELSE 'subdivision' END) AS kind,
              COALESCE(j.parent, CASE WHEN LENGTH(f.jurisdiction) > 2 THEN SUBSTR(f.jurisdiction, 1, 2) END) AS parent,
              COUNT(*) AS feature_count
         FROM features f
         LEFT JOIN jurisdictions j ON j.code = f.jurisdiction
        WHERE f.jurisdiction IS NOT NULL
        GROUP BY f.jurisdiction
        ORDER BY label`,
    )
    .all() as JurisdictionOption[];
}

/**
 * Rebuilds the jurisdiction registry from what has actually been harvested.
 *
 * Countries come from indexed `country` features and subdivisions from
 * `province_territory` ones, each contributing its own name and extent. Nothing here is
 * typed in: a hard-coded table of 250 country names and bounding boxes would sit beside
 * the real ones from Natural Earth and drift from them, and the extents would be worse
 * than the measured ones anyway.
 *
 * Canada's labels are the exception -- they are seeded by migration 8 and left alone,
 * because "Canada (federal)" says something about how the code is used that the country
 * feature's name ("Canada") does not.
 *
 * Extents are copied verbatim, INCLUDING the minx > maxx form that means the extent
 * crosses the antimeridian. Normalising that away here would undo the entire point of
 * measuring it; see harvester/normalize/antimeridian.ts.
 */
export function refreshJurisdictions(db: Db): { written: number } {
  const rows = db
    .prepare(
      `SELECT jurisdiction AS code,
              feature_type,
              official_name,
              minx, miny, maxx, maxy
         FROM features
        WHERE jurisdiction IS NOT NULL
          AND feature_type IN ('country', 'province_territory')`,
    )
    .all() as {
    code: string;
    feature_type: string;
    official_name: string;
    minx: number | null;
    miny: number | null;
    maxx: number | null;
    maxy: number | null;
  }[];

  const upsert = db.prepare(
    `INSERT INTO jurisdictions (code, label, kind, parent, minx, miny, maxx, maxy, updated_at)
     VALUES (@code, @label, @kind, @parent, @minx, @miny, @maxx, @maxy, @updated_at)
     ON CONFLICT(code) DO UPDATE SET
       label      = CASE WHEN @keep_label THEN jurisdictions.label ELSE excluded.label END,
       kind       = excluded.kind,
       parent     = excluded.parent,
       minx       = excluded.minx,
       miny       = excluded.miny,
       maxx       = excluded.maxx,
       maxy       = excluded.maxy,
       updated_at = excluded.updated_at`,
  );

  /*
   * One winner per code: the feature with the largest extent.
   *
   * Several features can legitimately share a code, because Natural Earth files some
   * dependencies under their sovereign's. Taking whichever arrived last made the registry
   * say France was "Clipperton I." with an extent of a single point 0.02 degrees across,
   * and Australia was "Ashmore and Cartier Is." Filtering by FR would then have been
   * labelled with a speck in the Pacific. The sovereign's own polygon dwarfs its
   * dependencies, so the largest extent is the country.
   */
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const held = best.get(r.code);
    if (!held || extentArea(r) > extentArea(held)) best.set(r.code, r);
  }

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    let written = 0;
    for (const r of best.values()) {
      // A country feature must carry a bare code and a subdivision a prefixed one. A row
      // that disagrees is skipped rather than filed under a code it does not describe.
      const isCountry = r.feature_type === 'country';
      if (isCountry !== (r.code.length === 2)) continue;

      upsert.run({
        code: r.code,
        label: r.official_name,
        kind: isCountry ? 'country' : 'subdivision',
        parent: isCountry ? null : r.code.slice(0, 2),
        minx: r.minx,
        miny: r.miny,
        maxx: r.maxx,
        maxy: r.maxy,
        updated_at: now,
        keep_label: CANADA_SEEDED_LABELS.has(r.code) ? 1 : 0,
      });
      written++;
    }
    return written;
  });

  return { written: run() };
}

/**
 * Rough extent area in square degrees, correct for an extent that crosses ±180.
 *
 * A wrapped extent has minx > maxx, so plain subtraction gives a large negative width and
 * would rank Russia and Alaska last instead of first.
 */
function extentArea(r: { minx: number | null; miny: number | null; maxx: number | null; maxy: number | null }): number {
  if (r.minx === null || r.miny === null || r.maxx === null || r.maxy === null) return -1;
  const width = r.minx > r.maxx ? 360 - r.minx + r.maxx : r.maxx - r.minx;
  return width * (r.maxy - r.miny);
}

/** Codes whose label migration 8 set deliberately, and which refresh must not overwrite. */
const CANADA_SEEDED_LABELS: ReadonlySet<string> = new Set(Object.keys(CANADA_SUBDIVISION_LABELS));

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

  /*
   * Refresh the jurisdiction registry here rather than at the call sites.
   *
   * There are three harvest loops -- the app's Tier A runner, the Tier B bulk runner and
   * the CLI's own -- and the first attempt hooked only one of them, so a CLI harvest of
   * all 56 US states left the registry empty and every state showed as a bare code. This
   * is the one function all three already call on success.
   */
  if (opts.status !== 'ok') return;
  const src = db.prepare('SELECT feature_type FROM sources WHERE id = ?').get(id) as
    | { feature_type: string }
    | undefined;
  if (src && (src.feature_type === 'country' || src.feature_type === 'province_territory')) {
    refreshJurisdictions(db);
  }
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
