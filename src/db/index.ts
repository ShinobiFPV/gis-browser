import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations';
import { SEED_SOURCES } from './seed/sources';
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

  const inserted = seedSources(db);
  if (inserted > 0) console.log(`[db] seeded ${inserted} source(s)`);

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
 * Inserts any seed rows not already present, keyed on (endpoint, layer_id, feature_type).
 * Existing rows are left alone -- a user may have disabled a source, and re-seeding must
 * not silently re-enable it or wipe harvest state.
 */
export function seedSources(db: Db): number {
  const insert = db.prepare(`
    INSERT INTO sources (
      name, kind, tier, endpoint, layer_id, feature_type, jurisdiction, vintage,
      licence, attribution, name_fields, status, source_srid, verified_count, verified_at, notes
    ) VALUES (
      @name, @kind, @tier, @endpoint, @layer_id, @feature_type, @jurisdiction, @vintage,
      @licence, @attribution, @name_fields, 'seeded', @source_srid, @verified_count, @verified_at, @notes
    )
    ON CONFLICT(endpoint, layer_id, feature_type) DO NOTHING
  `);

  const run = db.transaction(() => {
    let n = 0;
    for (const s of SEED_SOURCES) {
      assertFeatureType(s.featureType, `seed source "${s.name}"`);
      const info = insert.run({
        name: s.name,
        kind: s.kind,
        tier: s.tier,
        endpoint: s.endpoint,
        layer_id: s.layerId,
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
      });
      n += info.changes;
    }
    return n;
  });

  return run();
}
