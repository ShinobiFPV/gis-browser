import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations';
import { SEED_SOURCES } from './seed/sources';
import { applyManualAliases } from '@resolve/manual-aliases';
import { assertFeatureType } from '@shared/taxonomy';

export type Db = Database.Database;

let handle: Db | null = null;

/**
 * Opens (creating if needed) the catalog database, applies migrations, and makes sure
 * the seeded registry is present. Safe to call repeatedly -- returns the same handle.
 */
export function openDb(path: string): Db {
  if (handle) return handle;

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  // WAL keeps the harvester writing while the UI reads. The harvester runs in a
  // separate process and opens its own connection to the same file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');

  const { from, to } = migrate(db);
  if (from !== to) console.log(`[db] migrated schema ${from} -> ${to}`);

  const seeded = seedSources(db);
  if (seeded.inserted > 0) console.log(`[db] seeded ${seeded.inserted} new source(s)`);

  // Ingest rebuilds a feature's aliases from scratch, so the curated ones have to be
  // re-applied after any harvest. Doing it on open covers the case where the app is
  // restarted between a harvest and a search.
  const manual = applyManualAliases(db);
  if (manual.inserted > 0) console.log(`[db] applied ${manual.inserted} manual alias row(s)`);
  for (const u of manual.unmatched) {
    console.warn(`[db] manual alias "${u.alias}" has no target named "${u.target}" in the catalog`);
  }

  handle = db;
  return db;
}

export function getDb(): Db {
  if (!handle) throw new Error('openDb() has not been called yet');
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/**
 * Reconciles the database against the seed registry, keyed on
 * (endpoint, layer_id, feature_type).
 *
 * The seed file is the source of truth for what a source IS -- its name, licence,
 * attribution, name fields, vintage, SRID and verification metadata -- so those columns
 * are overwritten on every startup. That matters: a corrected name field (BC's
 * LAND_CLAIM_SETTLEMENT_NAME, say) has to reach existing installs, not just fresh ones.
 *
 * Harvest state is the database's own and is never touched: status, last_harvested_at and
 * feature_count survive re-seeding, so a disabled source stays disabled and a completed
 * harvest is not marked unharvested.
 */
export function seedSources(db: Db): { inserted: number; updated: number } {
  const exists = db.prepare(
    'SELECT id FROM sources WHERE endpoint = ? AND layer_id = ? AND feature_type = ?',
  );

  const insert = db.prepare(`
    INSERT INTO sources (
      name, kind, tier, endpoint, layer_id, feature_type, jurisdiction, vintage,
      licence, attribution, name_fields, status, source_srid, verified_count, verified_at, notes,
      identity_field, archive_bytes, region
    ) VALUES (
      @name, @kind, @tier, @endpoint, @layer_id, @feature_type, @jurisdiction, @vintage,
      @licence, @attribution, @name_fields, 'seeded', @source_srid, @verified_count, @verified_at, @notes,
      @identity_field, @archive_bytes, @region
    )
    ON CONFLICT(endpoint, layer_id, feature_type) DO UPDATE SET
      name           = excluded.name,
      kind           = excluded.kind,
      tier           = excluded.tier,
      jurisdiction   = excluded.jurisdiction,
      vintage        = excluded.vintage,
      licence        = excluded.licence,
      attribution    = excluded.attribution,
      name_fields    = excluded.name_fields,
      source_srid    = excluded.source_srid,
      verified_count = excluded.verified_count,
      verified_at    = excluded.verified_at,
      notes          = excluded.notes,
      identity_field = excluded.identity_field,
      archive_bytes  = excluded.archive_bytes,
      region         = excluded.region
      -- status, last_harvested_at and feature_count are deliberately not touched.
  `);

  const run = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    for (const s of SEED_SOURCES) {
      assertFeatureType(s.featureType, `seed source "${s.name}"`);
      const layerId = s.layerId ?? '';
      const already = exists.get(s.endpoint, layerId, s.featureType) !== undefined;
      insert.run({
        name: s.name,
        kind: s.kind,
        tier: s.tier,
        endpoint: s.endpoint,
        // Empty string rather than NULL: SQLite treats NULLs as distinct in UNIQUE
        // indexes, which would let every Tier B source re-insert on each startup.
        layer_id: layerId,
        feature_type: s.featureType,
        jurisdiction: s.jurisdiction,
        vintage: s.vintage,
        licence: s.licence,
        attribution: s.attribution,
        name_fields: JSON.stringify(s.nameFields),
        source_srid: s.sourceSrid,
        verified_count: s.verifiedCount,
        verified_at: s.verifiedAt,
        notes: s.notes ?? null,
        identity_field: s.identityField ?? null,
        archive_bytes: s.archiveBytes ?? null,
        // Canadian unless the source says otherwise, which is what every seeded source
        // was before the catalog went international.
        region: s.region ?? 'canada',
      });
      if (already) updated++;
      else inserted++;
    }
    return { inserted, updated };
  });

  return run();
}
