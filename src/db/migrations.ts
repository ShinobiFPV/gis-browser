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

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => db.exec(M1_INITIAL),
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
