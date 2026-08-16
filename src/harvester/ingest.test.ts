import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@db/migrations';
import type { SourceRow } from '@shared/types';
import { createIngestor } from './ingest';
import type { IndexedRow } from './catalogs/esri-rest';

/**
 * Ingest tests run against a real in-memory SQLite database with the real migrations, so
 * the CHECK constraints, triggers and R-tree are all exercised rather than mocked.
 */

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
    endpoint: 'https://example.test/MapServer',
    layer_id: '0',
    feature_type: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: 'test',
    licence: 'test',
    attribution: 'Test Attribution',
    name_fields: JSON.stringify(['ED_NAMEE', 'ED_NAMEF']),
    status: 'seeded',
    source_srid: 3978,
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

function row(attributes: Record<string, number | string>, bbox?: IndexedRow['bbox']): IndexedRow {
  return {
    sourceFeatureId: String(attributes['OBJECTID'] ?? '1'),
    attributes,
    bbox: bbox ?? { minx: -80.2, miny: 45.2, maxx: -80.0, maxy: 45.4 },
  };
}

let db: Db;
beforeEach(() => {
  db = freshDb();
});

describe('basic ingest', () => {
  it('writes a feature, its bbox and its aliases', () => {
    const source = addSource(db);
    const ing = createIngestor(db, source);
    ing.writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'Parry Sound—Muskoka', ED_NAMEF: 'Parry Sound—Muskoka' })]);

    const f = db.prepare('SELECT * FROM features').get() as Record<string, unknown>;
    expect(f['official_name']).toBe('Parry Sound—Muskoka');
    expect(f['minx']).toBeCloseTo(-80.2);

    const aliases = (db.prepare('SELECT alias FROM aliases ORDER BY alias').all() as { alias: string }[]).map(
      (a) => a.alias,
    );
    expect(aliases).toContain('Parry Sound—Muskoka');
    expect(aliases).toContain('parry sound-muskoka');
    expect(aliases).toContain('parry sound muskoka');

    // The FTS index is populated by trigger, not by the ingestor.
    const hit = db
      .prepare("SELECT COUNT(*) n FROM features_fts WHERE features_fts MATCH 'muskoka'")
      .get() as { n: number };
    expect(hit.n).toBeGreaterThan(0);

    const rtree = db.prepare('SELECT COUNT(*) n FROM features_rtree').get() as { n: number };
    expect(rtree.n).toBe(1);
  });

  it('refuses a row with no value in any declared name field', () => {
    const source = addSource(db);
    const ing = createIngestor(db, source);
    expect(() => ing.writeBatch([row({ OBJECTID: 1, SOMETHING_ELSE: 'x' })])).toThrow(/no value in any declared name field/);
  });

  it('rolls the whole page back when one row fails', () => {
    const source = addSource(db);
    const ing = createIngestor(db, source);
    expect(() =>
      ing.writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'Good' }), row({ OBJECTID: 2, NOPE: 'bad' })]),
    ).toThrow();
    const n = db.prepare('SELECT COUNT(*) n FROM features').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('re-harvesting replaces aliases rather than accumulating them', () => {
    const source = addSource(db);
    createIngestor(db, source).writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'Old Name' })]);
    const before = db.prepare('SELECT COUNT(*) n FROM aliases').get() as { n: number };

    createIngestor(db, source).writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'New Name' })]);
    const aliases = (db.prepare('SELECT alias FROM aliases').all() as { alias: string }[]).map((a) => a.alias);

    expect(aliases).toContain('New Name');
    expect(aliases).not.toContain('Old Name');
    expect(before.n).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) n FROM features').get()).toEqual({ n: 1 });
  });
});

describe('multipart merge via identity_field', () => {
  it('merges rows sharing an identity and unions their bboxes', () => {
    // Elections Canada's 2025 layer publishes one row per polygon: 352 rows, 343 ridings.
    const source = addSource(db, { identity_field: 'FED_NUM' });
    const ing = createIngestor(db, source);

    ing.writeBatch([
      { sourceFeatureId: '1', attributes: { OBJECTID: 1, FED_NUM: 35084, ED_NAMEE: 'Parry Sound—Muskoka' }, bbox: { minx: -80.5, miny: 45.0, maxx: -80.0, maxy: 45.5 } },
      { sourceFeatureId: '2', attributes: { OBJECTID: 2, FED_NUM: 35084, ED_NAMEE: 'Parry Sound—Muskoka' }, bbox: { minx: -81.0, miny: 44.5, maxx: -80.4, maxy: 45.2 } },
      { sourceFeatureId: '3', attributes: { OBJECTID: 3, FED_NUM: 35085, ED_NAMEE: 'Peterborough' }, bbox: { minx: -78.5, miny: 44.2, maxx: -78.0, maxy: 44.5 } },
    ]);

    expect(ing.stats.rowsSeen).toBe(3);
    expect(ing.stats.featuresWritten).toBe(2);
    expect(ing.stats.featuresMerged).toBe(1);

    const merged = db.prepare("SELECT * FROM features WHERE source_feature_id = '35084'").get() as Record<string, number>;
    expect(merged['minx']).toBeCloseTo(-81.0);
    expect(merged['miny']).toBeCloseTo(44.5);
    expect(merged['maxx']).toBeCloseTo(-80.0);
    expect(merged['maxy']).toBeCloseTo(45.5);

    // And the R-tree entry reflects the union, not just the last part seen.
    const r = db.prepare('SELECT minx, maxx FROM features_rtree WHERE id = ?').get(merged['id']!) as {
      minx: number;
      maxx: number;
    };
    expect(r.minx).toBeCloseTo(-81.0, 4);
    expect(r.maxx).toBeCloseTo(-80.0, 4);
  });

  it('fails loudly when a row is missing the identity field', () => {
    const source = addSource(db, { identity_field: 'FED_NUM' });
    const ing = createIngestor(db, source);
    expect(() => ing.writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'X' })])).toThrow(/does not carry it/);
  });
});

describe('feature type refinement', () => {
  it('splits the NRCan CLSS layer onto the right taxonomy types', () => {
    const source = addSource(db, {
      endpoint: 'https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer',
      feature_type: 'indian_reserve',
      name_fields: JSON.stringify(['adminAreaNameEng']),
    });
    const ing = createIngestor(db, source);
    ing.writeBatch([
      row({ OBJECTID: 1, adminAreaNameEng: 'PARRY ISLAND FIRST NATION', distributionTypeEng: 'Indian Reserve' }),
      row({ OBJECTID: 2, adminAreaNameEng: 'SOME INUIT LAND', distributionTypeEng: 'Inuit Owned Land' }),
      row({ OBJECTID: 3, adminAreaNameEng: 'TLICHO', distributionTypeEng: 'Tlicho Land' }),
    ]);

    const types = db
      .prepare('SELECT official_name, feature_type FROM features ORDER BY source_feature_id')
      .all() as { official_name: string; feature_type: string }[];
    expect(types.map((t) => t.feature_type)).toEqual(['indian_reserve', 'inuit_region', 'land_claim_settlement']);
  });

  it('separates census agglomerations from metropolitan areas', () => {
    const source = addSource(db, {
      feature_type: 'census_metropolitan_area',
      name_fields: JSON.stringify(['CMANAME']),
    });
    createIngestor(db, source).writeBatch([
      row({ OBJECTID: 1, CMANAME: "St. John's", CMATYPE: 'B' }),
      row({ OBJECTID: 2, CMANAME: 'Gander', CMATYPE: 'D' }),
    ]);
    const types = db.prepare('SELECT feature_type FROM features ORDER BY source_feature_id').all() as {
      feature_type: string;
    }[];
    expect(types.map((t) => t.feature_type)).toEqual(['census_metropolitan_area', 'census_agglomeration']);
  });
});

describe('jurisdiction derivation', () => {
  it('maps StatCan PRUID onto a province code', () => {
    const source = addSource(db, { name_fields: JSON.stringify(['CDNAME']), feature_type: 'census_division' });
    createIngestor(db, source).writeBatch([
      row({ OBJECTID: 1, CDNAME: 'Parry Sound', PRUID: '35' }),
      row({ OBJECTID: 2, CDNAME: 'Kootenay Boundary', PRUID: '59' }),
    ]);
    const j = db.prepare('SELECT jurisdiction FROM features ORDER BY source_feature_id').all() as {
      jurisdiction: string;
    }[];
    expect(j.map((x) => x.jurisdiction)).toEqual(['ON', 'BC']);
  });

  it('maps the CLSS jurisdictionEng name onto a province code', () => {
    const source = addSource(db, {
      endpoint: 'https://x/CLSS/MapServer',
      feature_type: 'indian_reserve',
      name_fields: JSON.stringify(['adminAreaNameEng']),
    });
    createIngestor(db, source).writeBatch([
      row({ OBJECTID: 1, adminAreaNameEng: 'X', distributionTypeEng: 'Indian Reserve', jurisdictionEng: 'Ontario' }),
    ]);
    expect(db.prepare('SELECT jurisdiction FROM features').get()).toEqual({ jurisdiction: 'ON' });
  });
});

describe('geometry sanity', () => {
  it('drops a bbox that is not in Canada instead of poisoning the R-tree', () => {
    const source = addSource(db);
    const ing = createIngestor(db, source);
    // Paris: the classic signature of an unhandled CRS.
    ing.writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'Somewhere' }, { minx: 2.2, miny: 48.8, maxx: 2.4, maxy: 48.9 })]);

    expect(ing.stats.bboxRejected).toBe(1);
    expect(db.prepare('SELECT minx FROM features').get()).toEqual({ minx: null });
    expect(db.prepare('SELECT COUNT(*) n FROM features_rtree').get()).toEqual({ n: 0 });
    // The feature itself is still indexed and searchable by name.
    expect(db.prepare('SELECT COUNT(*) n FROM features').get()).toEqual({ n: 1 });
  });
});

describe('schema guarantees', () => {
  it('rejects a feature_type outside the taxonomy at the database level', () => {
    expect(() => addSource(db, { feature_type: 'not_a_real_type' as SourceRow['feature_type'] })).toThrow();
  });

  it('cascades feature deletion to aliases, the FTS index and the R-tree', () => {
    const source = addSource(db);
    createIngestor(db, source).writeBatch([row({ OBJECTID: 1, ED_NAMEE: 'Doomed' })]);
    expect(db.prepare('SELECT COUNT(*) n FROM features_rtree').get()).toEqual({ n: 1 });

    db.prepare('DELETE FROM sources WHERE id = ?').run(source.id);

    expect(db.prepare('SELECT COUNT(*) n FROM features').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM aliases').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM features_fts').get()).toEqual({ n: 0 });
    // The R-tree is a virtual table with no foreign key, so it needs its own trigger.
    // An orphan here would make a bbox search return ids that no longer exist.
    expect(db.prepare('SELECT COUNT(*) n FROM features_rtree').get()).toEqual({ n: 0 });
  });
});
