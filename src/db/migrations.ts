import type BetterSqlite3 from 'better-sqlite3';
import { FEATURE_TYPES } from '@shared/taxonomy';

/**
 * Migrations are append-only. Each entry runs once, inside a transaction, and
 * `user_version` records how far we got. Never edit a shipped migration -- add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: BetterSqlite3.Database) => void;
}

// The CHECK constraint is generated from the taxonomy so the two cannot drift.
const FEATURE_TYPE_CHECK = FEATURE_TYPES.map((t) => `'${t}'`).join(',');

const M1_INITIAL = `
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('arcgis-hub','esri-rest','wfs','ckan','bulk-file')),
  tier TEXT NOT NULL CHECK (tier IN ('A','B')),
  endpoint TEXT NOT NULL,
  layer_id TEXT,
  feature_type TEXT NOT NULL CHECK (feature_type IN (${FEATURE_TYPE_CHECK})),
  jurisdiction TEXT,
  vintage TEXT,
  licence TEXT,
  attribution TEXT,
  name_fields TEXT,
  last_harvested_at TEXT,
  feature_count INTEGER,
  status TEXT NOT NULL DEFAULT 'seeded'
    CHECK (status IN ('seeded','harvesting','ok','stale','failed','disabled')),

  -- Verification metadata: what the live service reported when the endpoint was
  -- confirmed, so a harvest that returns a different count can be flagged.
  source_srid INTEGER,
  verified_count INTEGER,
  verified_at TEXT,
  notes TEXT,

  UNIQUE(endpoint, layer_id, feature_type)
);

CREATE INDEX idx_sources_type ON sources(feature_type);
CREATE INDEX idx_sources_jurisdiction ON sources(jurisdiction);

CREATE TABLE features (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_feature_id TEXT NOT NULL,
  official_name TEXT NOT NULL,
  feature_type TEXT NOT NULL CHECK (feature_type IN (${FEATURE_TYPE_CHECK})),
  jurisdiction TEXT,
  attributes_json TEXT NOT NULL,
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  retrieved_at TEXT NOT NULL,
  UNIQUE(source_id, source_feature_id)
);

CREATE INDEX idx_features_source ON features(source_id);
CREATE INDEX idx_features_type ON features(feature_type);
CREATE INDEX idx_features_jurisdiction ON features(jurisdiction);
CREATE INDEX idx_features_name ON features(official_name);

CREATE TABLE geometries (
  feature_id INTEGER PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  geometry_json TEXT NOT NULL,
  vertex_count INTEGER,
  source_srid INTEGER,
  content_hash TEXT,
  cached_at TEXT NOT NULL
);

CREATE TABLE aliases (
  id INTEGER PRIMARY KEY,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_kind TEXT CHECK (alias_kind IN ('official','french','attribute','stripped','manual')),
  UNIQUE(feature_id, alias)
);

CREATE INDEX idx_aliases_feature ON aliases(feature_id);
CREATE INDEX idx_aliases_alias ON aliases(alias);

-- External-content FTS: rowid == aliases.id, kept in sync by the triggers below.
CREATE VIRTUAL TABLE features_fts USING fts5(
  alias, content='', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER aliases_ai AFTER INSERT ON aliases BEGIN
  INSERT INTO features_fts(rowid, alias) VALUES (new.id, new.alias);
END;
CREATE TRIGGER aliases_ad AFTER DELETE ON aliases BEGIN
  INSERT INTO features_fts(features_fts, rowid, alias) VALUES('delete', old.id, old.alias);
END;
CREATE TRIGGER aliases_au AFTER UPDATE ON aliases BEGIN
  INSERT INTO features_fts(features_fts, rowid, alias) VALUES('delete', old.id, old.alias);
  INSERT INTO features_fts(rowid, alias) VALUES (new.id, new.alias);
END;

CREATE VIRTUAL TABLE features_rtree USING rtree(id, minx, maxx, miny, maxy);

-- Resumable harvest: one checkpoint row per source, so an interrupted paging run
-- restarts at the right offset instead of from zero.
CREATE TABLE harvest_checkpoints (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  next_offset INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT,
  last_error TEXT
);

-- Downloaded Tier B archives, so a 400MB file is fetched once and reused.
CREATE TABLE bulk_downloads (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  bytes INTEGER,
  sha256 TEXT,
  downloaded_at TEXT NOT NULL,
  UNIQUE(source_id, url)
);
`;

/**
 * Multipart layers publish one row per polygon. Elections Canada's 2025 layer returns 352
 * rows for 343 ridings. `identity_field` names the attribute that identifies the real
 * feature, so ingest merges the parts instead of writing nine phantom ridings.
 */
const M2_IDENTITY_FIELD = `
ALTER TABLE sources ADD COLUMN identity_field TEXT;
`;

/**
 * `UNIQUE(endpoint, layer_id, feature_type)` never fired for Tier B sources, because
 * SQLite treats NULLs as distinct inside a UNIQUE index -- so every bulk-file source with
 * a NULL layer_id was re-inserted on each startup. Collapse NULL to the empty string so
 * the constraint does its job, after removing the duplicates it already let through.
 */
const M3_BULK_SOURCE_UNIQUENESS = `
DELETE FROM sources WHERE id NOT IN (
  SELECT MIN(id) FROM sources GROUP BY endpoint, COALESCE(layer_id, ''), feature_type
);
UPDATE sources SET layer_id = '' WHERE layer_id IS NULL;
`;

/**
 * `features_rtree` is a virtual table, so it cannot carry a foreign key and was never
 * cleaned up when a feature was deleted -- neither by the ON DELETE CASCADE from sources
 * nor by a direct delete. Orphaned entries make a bbox search return ids that no longer
 * exist. Mirror what the alias triggers already do for the FTS index, and sweep the
 * orphans that accumulated before the trigger existed.
 */
const M4_RTREE_CLEANUP = `
DELETE FROM features_rtree WHERE id NOT IN (SELECT id FROM features);

CREATE TRIGGER features_ad AFTER DELETE ON features BEGIN
  DELETE FROM features_rtree WHERE id = old.id;
END;
`;

/**
 * Some boundaries are too big to serve at full resolution: StatCan answers a
 * single-feature query for Nunavut with HTTP 500 after ~20 seconds, and only succeeds
 * once the geometry is generalised. When that happens we keep the coarser shape rather
 * than nothing -- but a boundary that went to air generalised is a provenance fact, so
 * record the offset used. NULL means full resolution.
 */
const M5_GENERALISATION = `
ALTER TABLE geometries ADD COLUMN generalisation_deg REAL;
`;

/**
 * The download size of a Tier B archive, in bytes, measured during registry verification.
 *
 * The brief makes Tier B explicitly user-triggered because these are whole-file downloads,
 * and that only means something if the user is told the cost before committing: the
 * dissemination-area archive is 197 MB and expands to well over half a gigabyte. NULL for
 * every Tier A source, which streams pages and never downloads a file.
 */
const M6_ARCHIVE_BYTES = `
ALTER TABLE sources ADD COLUMN archive_bytes INTEGER;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => db.exec(M1_INITIAL),
  },
  {
    version: 2,
    name: 'sources.identity_field for multipart layers',
    up: (db) => db.exec(M2_IDENTITY_FIELD),
  },
  {
    version: 3,
    name: 'stop re-seeding Tier B sources with NULL layer_id',
    up: (db) => db.exec(M3_BULK_SOURCE_UNIQUENESS),
  },
  {
    version: 4,
    name: 'cascade feature deletion into the R-tree',
    up: (db) => db.exec(M4_RTREE_CLEANUP),
  },
  {
    version: 5,
    name: 'record source-side generalisation on cached geometry',
    up: (db) => db.exec(M5_GENERALISATION),
  },
  {
    version: 6,
    name: 'record Tier B archive download size',
    up: (db) => db.exec(M6_ARCHIVE_BYTES),
  },
];

export function migrate(db: BetterSqlite3.Database): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  let current = from;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      m.up(db);
      // pragma cannot be parameterised; version is an integer literal from our own array.
      db.pragma(`user_version = ${m.version}`);
    });
    run();
    current = m.version;
  }

  return { from, to: current };
}
