import type BetterSqlite3 from 'better-sqlite3';
import { FEATURE_TYPES } from '@shared/taxonomy';
import { CANADA_SUBDIVISION_BBOX, CANADA_SUBDIVISION_LABELS } from '@shared/jurisdictions';

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

/**
 * Candidates found by the M7 crawlers, held apart from `sources` until a person accepts
 * one.
 *
 * A separate table rather than a status column on `sources`, because these are not sources
 * yet and must not be reachable by anything that harvests or searches. ArcGIS Hub answers
 * "provincial electoral districts" with 657,212 matches; the good ones and the municipal
 * extracts wearing the same title arrive in the same page, and the difference decides
 * whether a real riding or a five-polygon fragment goes to air.
 *
 * Keyed on the endpoint so re-running a crawl updates a candidate instead of stacking
 * duplicates, and so the decision already recorded against it survives.
 */
const M7_DISCOVERED = `
CREATE TABLE discovered_sources (
  id INTEGER PRIMARY KEY,
  catalog TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  title TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  layer_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  publisher TEXT,
  feature_type TEXT,
  jurisdiction TEXT,
  name_fields TEXT,
  source_srid INTEGER,
  licence TEXT,
  description TEXT,
  record_count INTEGER,
  live_count INTEGER,
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  confidence REAL NOT NULL DEFAULT 0,
  concerns TEXT,
  validated INTEGER NOT NULL DEFAULT 0,
  validation_error TEXT,
  -- 'new' until someone rules on it; 'accepted' once promoted into sources.
  decision TEXT NOT NULL DEFAULT 'new' CHECK (decision IN ('new','accepted','rejected')),
  discovered_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE(endpoint, layer_id)
);

CREATE INDEX idx_discovered_decision ON discovered_sources(decision, confidence DESC);
`;

/**
 * Country-prefix every Canadian jurisdiction code, and record what each code means.
 *
 * The codes were bare -- AB, BC, NL -- which worked exactly as long as the catalog was
 * Canadian. Five of the thirteen are also ISO 3166-1 country codes for somewhere else
 * (NL Netherlands, NU Niue, PE Peru, SK Slovakia, YT Mayotte), so the first country
 * harvest would have merged Newfoundland into the Netherlands without erroring. Every
 * code below a country now carries its country: CA-NL. Bare CA still means Canada.
 *
 * The `jurisdictions` table is the registry those codes resolve against. It is populated
 * from harvested data rather than typed in, because the alternative is a table of 250
 * country names and extents written from memory sitting next to the real ones from
 * Natural Earth -- two sets of facts that would drift. Canada's own subdivisions are
 * seeded here since discovery needs them before anything is harvested.
 */
const M8_INTERNATIONAL_JURISDICTIONS = `
UPDATE features SET jurisdiction = 'CA-' || jurisdiction
  WHERE jurisdiction IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');
UPDATE sources SET jurisdiction = 'CA-' || jurisdiction
  WHERE jurisdiction IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');
UPDATE discovered_sources SET jurisdiction = 'CA-' || jurisdiction
  WHERE jurisdiction IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');

CREATE TABLE jurisdictions (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  -- 'country' or 'subdivision'. Kept explicit rather than inferred from the code shape
  -- so a query can group without parsing strings.
  kind TEXT NOT NULL CHECK (kind IN ('country','subdivision')),
  -- NULL for a country; the containing country code for a subdivision.
  parent TEXT,
  -- Extent, learned from the harvested boundary. minx > maxx means the extent crosses the
  -- antimeridian; see harvester/normalize/antimeridian.ts. Alaska and Russia both do.
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  -- The feature this was learned from, so the extent can be traced and refreshed.
  feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
  updated_at TEXT
);

CREATE INDEX idx_jurisdictions_parent ON jurisdictions(parent);

/*
 * Which part of the world a source is allowed to cover.
 *
 * Every existing source is Canadian, which is why the default is 'canada' and why that
 * default is correct for every row already in the table. Ingest uses this to decide
 * whether geometry outside Canada is a CRS bug to reject or simply the rest of the
 * planet: the Natural Earth countries layer was being filtered down to the four
 * countries touching Canada, which was right when the catalog was Canadian and is
 * exactly what has to stop now.
 */
ALTER TABLE sources ADD COLUMN region TEXT NOT NULL DEFAULT 'canada'
  CHECK (region IN ('canada','world'));

/*
 * Give every feature TWO R-tree slots instead of one.
 *
 * SQLite's rtree enforces minx <= maxx, so an antimeridian-crossing extent cannot be
 * stored as a single row -- harvesting Alaska fails outright with "rtree constraint
 * failed: features_rtree.(minx<=maxx)". The fix is to index such a feature as its two
 * lobes: the part east of minx up to 180, and the part from -180 up to maxx.
 *
 * Slots are feature_id*2 and feature_id*2+1 rather than a separate mapping table, so
 * deletion stays a single statement and no join is needed to get from a hit back to a
 * feature (id >> 1). Existing rows move from id to id*2.
 */
DELETE FROM features_rtree WHERE id NOT IN (SELECT id FROM features);

CREATE TABLE rtree_migrate_8 AS SELECT id, minx, maxx, miny, maxy FROM features_rtree;
DELETE FROM features_rtree;
INSERT INTO features_rtree (id, minx, maxx, miny, maxy)
  SELECT id * 2, minx, maxx, miny, maxy FROM rtree_migrate_8;
DROP TABLE rtree_migrate_8;

DROP TRIGGER features_ad;
CREATE TRIGGER features_ad AFTER DELETE ON features BEGIN
  DELETE FROM features_rtree WHERE id IN (old.id * 2, old.id * 2 + 1);
END;
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
  {
    version: 7,
    name: 'staging table for crawler-discovered sources',
    up: (db) => db.exec(M7_DISCOVERED),
  },
  {
    version: 8,
    name: 'country-prefix jurisdiction codes and add the jurisdiction registry',
    up: (db) => {
      db.exec(M8_INTERNATIONAL_JURISDICTIONS);

      // Canada's own entries, seeded from the shared table so the codes, labels and
      // extents cannot drift from the ones discovery scores against.
      const insert = db.prepare(
        `INSERT INTO jurisdictions (code, label, kind, parent, minx, miny, maxx, maxy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const [code, label] of Object.entries(CANADA_SUBDIVISION_LABELS)) {
        const box = CANADA_SUBDIVISION_BBOX[code]!;
        insert.run(
          code,
          label,
          code === 'CA' ? 'country' : 'subdivision',
          code === 'CA' ? null : 'CA',
          box.minLon,
          box.minLat,
          box.maxLon,
          box.maxLat,
          now,
        );
      }
    },
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
