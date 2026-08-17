import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrations';
import { listJurisdictions, refreshJurisdictions } from './queries';

/**
 * The jurisdiction registry, against a real database with the real migrations.
 *
 * Worth testing directly because the registry is what every jurisdiction label in the UI
 * comes from, and its first version got the most visible case wrong -- see the
 * dependency test below.
 */

type Db = Database.Database;

function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

let db: Db;
let sourceId: number;

function addFeature(opts: {
  name: string;
  jurisdiction: string;
  type?: string;
  bbox?: [number, number, number, number];
}): void {
  const [minx, miny, maxx, maxy] = opts.bbox ?? [0, 0, 1, 1];
  db.prepare(
    `INSERT INTO features (source_id, source_feature_id, official_name, feature_type,
                           jurisdiction, attributes_json, minx, miny, maxx, maxy, retrieved_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(sourceId, opts.name, opts.name, opts.type ?? 'country', opts.jurisdiction, minx, miny, maxx, maxy, new Date().toISOString());
}

beforeEach(() => {
  db = freshDb();
  db.prepare(
    `INSERT INTO sources (name, kind, tier, endpoint, layer_id, feature_type, jurisdiction,
                          licence, attribution, name_fields, status, region)
     VALUES ('NE', 'bulk-file', 'B', 'https://example.test/x.zip', '', 'country', NULL,
             'Public domain', 'Natural Earth', '["NAME"]', 'ok', 'world')`,
  ).run();
  sourceId = (db.prepare('SELECT id FROM sources').get() as { id: number }).id;
});

describe('migration 8', () => {
  it('seeds Canada with labels and extents', () => {
    const rows = db.prepare('SELECT code, label, kind, parent FROM jurisdictions ORDER BY code').all() as {
      code: string;
      label: string;
      kind: string;
      parent: string | null;
    }[];

    expect(rows).toHaveLength(14);
    expect(rows.find((r) => r.code === 'CA')).toMatchObject({ label: 'Canada (federal)', kind: 'country', parent: null });
    expect(rows.find((r) => r.code === 'CA-ON')).toMatchObject({ label: 'Ontario', kind: 'subdivision', parent: 'CA' });
    // No bare provincial code survives; that is the whole point of the migration.
    expect(rows.some((r) => r.code === 'ON')).toBe(false);
  });
});

describe('refreshJurisdictions', () => {
  it('learns a country from its harvested feature', () => {
    addFeature({ name: 'Japan', jurisdiction: 'JP', bbox: [122.9, 24.2, 154.0, 45.5] });
    refreshJurisdictions(db);

    const jp = db.prepare("SELECT * FROM jurisdictions WHERE code = 'JP'").get() as {
      label: string;
      kind: string;
      parent: string | null;
      minx: number;
    };
    expect(jp).toMatchObject({ label: 'Japan', kind: 'country', parent: null });
    expect(jp.minx).toBeCloseTo(122.9, 1);
  });

  it('picks the SOVEREIGN over its dependencies when they share a code', () => {
    /*
     * The bug this exists to prevent. Natural Earth files some dependencies under their
     * sovereign's ISO code, so FR is claimed by both France and Clipperton Island. Taking
     * whichever arrived last made the registry report France as "Clipperton I." with an
     * extent 0.02 degrees across -- a speck in the Pacific standing in for a country.
     */
    addFeature({ name: 'France', jurisdiction: 'FR', bbox: [-61.8, -21.4, 55.9, 51.1] });
    addFeature({ name: 'Clipperton I.', jurisdiction: 'FR', bbox: [-109.23, 10.28, -109.21, 10.31] });
    refreshJurisdictions(db);

    const fr = db.prepare("SELECT label, minx, maxx FROM jurisdictions WHERE code = 'FR'").get() as {
      label: string;
      minx: number;
      maxx: number;
    };
    expect(fr.label).toBe('France');
    expect(fr.minx).toBeCloseTo(-61.8, 1);
  });

  it('ranks a wrapped extent by its real width, not a negative one', () => {
    // Russia's extent crosses the antimeridian, so maxx < minx. Measured naively its
    // width is about -189 degrees, which would lose to any speck sharing its code.
    addFeature({ name: 'Russia', jurisdiction: 'RU', bbox: [19.6, 41.2, -169.0, 81.9] });
    addFeature({ name: 'Some Rock', jurisdiction: 'RU', bbox: [40.0, 50.0, 41.0, 51.0] });
    refreshJurisdictions(db);

    expect(db.prepare("SELECT label FROM jurisdictions WHERE code = 'RU'").get()).toEqual({ label: 'Russia' });
  });

  it('keeps the seeded Canadian labels rather than overwriting them', () => {
    // The country feature is simply named "Canada"; the registry label says what the code
    // is used for, which is more useful to someone picking a filter.
    addFeature({ name: 'Canada', jurisdiction: 'CA', bbox: [-141, 41.7, -52.6, 83.1] });
    refreshJurisdictions(db);

    expect(db.prepare("SELECT label FROM jurisdictions WHERE code = 'CA'").get()).toEqual({
      label: 'Canada (federal)',
    });
  });

  it('refuses a row whose code and type disagree', () => {
    // A country feature must carry a bare code. Filing a subdivision code as a country
    // would put it in the wrong group and give it no parent.
    addFeature({ name: 'Confused', jurisdiction: 'US-TX', type: 'country' });
    refreshJurisdictions(db);

    expect(db.prepare("SELECT COUNT(*) n FROM jurisdictions WHERE code = 'US-TX'").get()).toEqual({ n: 0 });
  });

  it('records a state as a subdivision of its country', () => {
    addFeature({ name: 'Texas', jurisdiction: 'US-TX', type: 'province_territory', bbox: [-106.6, 25.8, -93.5, 36.5] });
    refreshJurisdictions(db);

    expect(db.prepare("SELECT kind, parent FROM jurisdictions WHERE code = 'US-TX'").get()).toEqual({
      kind: 'subdivision',
      parent: 'US',
    });
  });
});

describe('listJurisdictions', () => {
  it('offers only codes that have features behind them', () => {
    addFeature({ name: 'Japan', jurisdiction: 'JP' });
    refreshJurisdictions(db);

    const codes = listJurisdictions(db).map((j) => j.code);
    expect(codes).toContain('JP');
    // Canada is in the registry from the migration but has nothing indexed, so it must
    // not appear as a filter that can only ever return nothing.
    expect(codes).not.toContain('CA-ON');
  });

  it('falls back to the bare code when the registry has no label yet', () => {
    addFeature({ name: 'Somewhere', jurisdiction: 'ZZ' });
    const [only] = listJurisdictions(db);
    expect(only).toMatchObject({ code: 'ZZ', label: 'ZZ', kind: 'country', feature_count: 1 });
  });
});
