import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@db/migrations';
import { createIngestor } from '../harvester/ingest';
import type { SourceRow } from '@shared/types';
import { quickFind, toFtsQuery } from './quick-find';

type Db = Database.Database;

function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function addSource(db: Db, over: Partial<SourceRow> = {}): SourceRow {
  const base = {
    name: 'Test Source',
    kind: 'esri-rest',
    tier: 'A',
    endpoint: `https://example.test/${String(over.name ?? 'a')}/MapServer`,
    layer_id: '0',
    feature_type: 'indian_reserve',
    jurisdiction: 'ON',
    vintage: 'current',
    licence: 'OGL',
    attribution: 'Test Attribution',
    name_fields: JSON.stringify(['NAME', 'NAME_FR']),
    status: 'ok',
    source_srid: 4326,
    verified_count: null,
    verified_at: '2026-08-16',
    notes: null,
    identity_field: null,
    ...over,
  };
  const info = db
    .prepare(
      `INSERT INTO sources (name, kind, tier, endpoint, layer_id, feature_type, jurisdiction, vintage,
        licence, attribution, name_fields, status, source_srid, verified_count, verified_at, notes, identity_field)
       VALUES (@name, @kind, @tier, @endpoint, @layer_id, @feature_type, @jurisdiction, @vintage,
        @licence, @attribution, @name_fields, @status, @source_srid, @verified_count, @verified_at, @notes, @identity_field)`,
    )
    .run(base);
  return { id: Number(info.lastInsertRowid), ...base } as SourceRow;
}

function seedFeatures(db: Db, source: SourceRow, names: [number, string, string?][]): void {
  const ing = createIngestor(db, source);
  ing.writeBatch(
    names.map(([oid, name, fr]) => ({
      sourceFeatureId: String(oid),
      attributes: fr ? { OBJECTID: oid, NAME: name, NAME_FR: fr } : { OBJECTID: oid, NAME: name },
      bbox: { minx: -80.2, miny: 45.2, maxx: -80.0, maxy: 45.4 },
    })),
  );
}

describe('toFtsQuery', () => {
  it('quotes tokens and prefix-matches only the last one', () => {
    expect(toFtsQuery('parry island')).toBe('"parry" AND "island"*');
  });

  it('folds case and diacritics', () => {
    expect(toFtsQuery('Québec')).toBe('"quebec"*');
  });

  it('neutralises FTS5 operator syntax in user input', () => {
    // Bare AND/OR/NOT and quotes would otherwise change or break the query.
    expect(toFtsQuery('a OR b')).toBe('"a" AND "or" AND "b"*');
    expect(toFtsQuery('foo" NEAR bar')).toBe('"foo" AND "near" AND "bar"*');
    expect(toFtsQuery('*')).toBeNull();
  });

  it('splits on punctuation including em dashes', () => {
    expect(toFtsQuery('Parry Sound—Muskoka')).toBe('"parry" AND "sound" AND "muskoka"*');
  });

  it('returns null when there is nothing to search for', () => {
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('')).toBeNull();
  });
});

describe('quickFind', () => {
  let db: Db;
  let source: SourceRow;

  beforeEach(() => {
    db = freshDb();
    source = addSource(db);
    seedFeatures(db, source, [
      [1, 'Parry Island First Nation'],
      [2, 'Shoal Lake Indian Reserve No. 39A'],
      [3, 'Wikwemikong Unceded Indian Reserve'],
      [4, 'Thunder Bay—Superior North', 'Thunder Bay—Supérieur-Nord'],
    ]);
  });

  it('finds a feature by its full name', () => {
    const hits = quickFind(db, 'Parry Island First Nation');
    expect(hits[0]?.officialName).toBe('Parry Island First Nation');
  });

  it('finds it by the stripped form a person would type', () => {
    expect(quickFind(db, 'parry island')[0]?.officialName).toBe('Parry Island First Nation');
  });

  it('prefix-matches a partial last word', () => {
    expect(quickFind(db, 'parry isl')[0]?.officialName).toBe('Parry Island First Nation');
  });

  it('matches across the em dash without one being typed', () => {
    expect(quickFind(db, 'thunder bay superior north')[0]?.officialName).toBe('Thunder Bay—Superior North');
  });

  it('matches the French name too', () => {
    expect(quickFind(db, 'superieur nord')[0]?.officialName).toBe('Thunder Bay—Superior North');
  });

  it('finds a reserve without its number', () => {
    expect(quickFind(db, 'shoal lake')[0]?.officialName).toBe('Shoal Lake Indian Reserve No. 39A');
  });

  it('returns each feature once however many aliases matched', () => {
    const hits = quickFind(db, 'parry island first nation');
    expect(hits.filter((h) => h.officialName === 'Parry Island First Nation')).toHaveLength(1);
  });

  it('carries the provenance the UI needs, and no geometry', () => {
    const hit = quickFind(db, 'parry island')[0]!;
    expect(hit.sourceName).toBe('Test Source');
    expect(hit.attribution).toBe('Test Attribution');
    expect(hit.jurisdiction).toBe('ON');
    expect(hit.bbox).toEqual([-80.2, 45.2, -80.0, 45.4]);
    expect(hit.hasCachedGeometry).toBe(false);
    expect(hit).not.toHaveProperty('geometry');
  });

  it('reports a cached geometry once one exists', () => {
    const id = quickFind(db, 'parry island')[0]!.featureId;
    db.prepare(
      "INSERT INTO geometries (feature_id, geometry_json, vertex_count, cached_at) VALUES (?, '{}', 4, 'now')",
    ).run(id);
    expect(quickFind(db, 'parry island')[0]?.hasCachedGeometry).toBe(true);
  });

  it('filters by feature type and jurisdiction', () => {
    expect(quickFind(db, 'parry island', { featureType: 'indian_reserve' })).toHaveLength(1);
    expect(quickFind(db, 'parry island', { featureType: 'census_division' })).toHaveLength(0);
    expect(quickFind(db, 'parry island', { jurisdiction: 'ON' })).toHaveLength(1);
    expect(quickFind(db, 'parry island', { jurisdiction: 'BC' })).toHaveLength(0);
  });

  it('returns duplicates from different sources rather than hiding one', () => {
    // Duplicate coverage is expected; ranking decides, the matcher must not pre-empt it.
    const other = addSource(db, { name: 'Federal Source', jurisdiction: 'CA', endpoint: 'https://other.test/MapServer' });
    seedFeatures(db, other, [[1, 'Parry Island First Nation']]);
    const hits = quickFind(db, 'parry island');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.sourceName))).toEqual(new Set(['Test Source', 'Federal Source']));
  });

  it('scores the best match at 1 and never below 0', () => {
    const hits = quickFind(db, 'parry island');
    expect(hits[0]?.matchScore).toBe(1);
    for (const h of hits) expect(h.matchScore).toBeGreaterThanOrEqual(0);
  });

  it('honours the limit', () => {
    expect(quickFind(db, 'reserve', { limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it('returns nothing for an unknown name rather than guessing', () => {
    // "Wasauksing" is genuinely absent from the official sources; fuzzy matching and a
    // manual alias table are M3's job, not this one's.
    expect(quickFind(db, 'wasauksing')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(quickFind(db, '   ')).toEqual([]);
  });
});
