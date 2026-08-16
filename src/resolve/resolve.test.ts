import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@db/migrations';
import { createIngestor } from '../harvester/ingest';
import type { SourceRow } from '@shared/types';
import { resolve, invalidateFuzzyIndex, toFtsQuery } from './resolve';
import { applyManualAliases, MANUAL_ALIASES } from './manual-aliases';

type Db = Database.Database;

/**
 * These run against a real in-memory catalog built through the real ingest path, so the
 * aliases under test are exactly the ones a harvest would produce. The names and
 * spellings below are taken from the live services, including NRCan's all-caps style.
 */

function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  invalidateFuzzyIndex();
  return db;
}

function addSource(db: Db, over: Partial<SourceRow>): SourceRow {
  const base = {
    name: 'Source',
    kind: 'esri-rest',
    tier: 'A',
    endpoint: `https://test/${String(over.name ?? 'x')}`,
    layer_id: '0',
    feature_type: 'indian_reserve',
    jurisdiction: 'CA',
    vintage: 'current',
    licence: 'OGL',
    attribution: 'Test',
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

function seed(db: Db, source: SourceRow, rows: [number, string, string?][]): void {
  createIngestor(db, source).writeBatch(
    rows.map(([oid, name, fr]) => ({
      sourceFeatureId: String(oid),
      attributes: fr ? { OBJECTID: oid, NAME: name, NAME_FR: fr } : { OBJECTID: oid, NAME: name },
      bbox: { minx: -80.2, miny: 45.2, maxx: -80.0, maxy: 45.4 },
    })),
  );
  invalidateFuzzyIndex();
}

/** Rebuilds the three-source picture the live catalog actually has for Parry Island. */
function buildCatalog(db: Db): void {
  const nrcan = addSource(db, {
    name: 'Aboriginal Lands of Canada Legislative Boundaries',
    attribution: 'Natural Resources Canada, Surveyor General Branch',
    jurisdiction: 'CA',
    feature_type: 'indian_reserve',
  });
  const lio = addSource(db, {
    name: 'Ontario First Nation Reserves (LIO)',
    attribution: '© King’s Printer for Ontario',
    jurisdiction: 'ON',
    feature_type: 'indian_reserve',
  });
  const statcan = addSource(db, {
    name: 'Census Subdivisions — 2021',
    attribution: 'Statistics Canada, 2021 Census — Cartographic Boundary Files',
    jurisdiction: 'CA',
    feature_type: 'census_subdivision',
    vintage: '2021 census',
  });
  const elections = addSource(db, {
    name: 'Federal Electoral Districts — 2023 Representation Order',
    attribution: 'Elections Canada',
    jurisdiction: 'CA',
    feature_type: 'federal_electoral_district',
    vintage: '2023 representation order',
  });

  seed(db, nrcan, [
    [1, 'PARRY ISLAND FIRST NATION'],
    [2, 'WIKWEMIKONG UNCEDED RESERVE'],
    [3, 'SIX NATIONS INDIAN RESERVE NO. 40'],
    [4, 'WALPOLE ISLAND INDIAN RESERVE NO. 46'],
    [5, 'SARNIA INDIAN RESERVE NO. 45'],
    [6, 'AKWESASNE RESERVE NO. 59'],
    [7, 'CURVE LAKE INDIAN RESERVE NO. 35'],
  ]);
  seed(db, lio, [
    [1, 'Parry Island First Nation'],
    [2, 'Wikwemikong Unceded 26'],
    [3, 'Walpole Island 46'],
    [4, 'Sarnia 45'],
    [5, 'Akwesasne 59'],
  ]);
  seed(db, statcan, [
    [1, 'Parry Island First Nation'],
    [2, 'Parry Sound'],
    [3, 'Toronto'],
  ]);
  seed(db, elections, [
    [1, 'Parry Sound--Muskoka'],
    [2, 'Toronto Centre'],
    [3, 'Thunder Bay--Superior North', 'Thunder Bay--Supérieur-Nord'],
  ]);
}

let db: Db;
beforeEach(() => {
  db = freshDb();
  buildCatalog(db);
});

describe('toFtsQuery', () => {
  it('requires every token in "all" mode and allows any in "any" mode', () => {
    expect(toFtsQuery('parry island', 'all')).toBe('"parry" AND "island"*');
    expect(toFtsQuery('parry island', 'any')).toBe('"parry" OR "island"*');
  });

  it('neutralises FTS5 operator syntax typed by a user', () => {
    expect(toFtsQuery('a OR b', 'all')).toBe('"a" AND "or" AND "b"*');
    expect(toFtsQuery('foo" NEAR bar', 'all')).toBe('"foo" AND "near" AND "bar"*');
    expect(toFtsQuery('*', 'all')).toBeNull();
  });
});

describe('M3 ACCEPTANCE — "Parry Island First Nation", LLM off', () => {
  it('returns the correct reserve in the top 3', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation');
    const top3 = candidates.slice(0, 3);
    expect(top3.some((c) => c.officialName.toUpperCase() === 'PARRY ISLAND FIRST NATION')).toBe(true);
  });

  it('returns it at the top from the full plain-language request', () => {
    // The brief's literal example sentence, not just the bare name.
    const { candidates } = resolve(db, 'Give me the outline shape for Parry Island First Nation');
    expect(candidates[0]?.officialName.toUpperCase()).toBe('PARRY ISLAND FIRST NATION');
    expect(candidates[0]?.featureType).toBe('indian_reserve');
  });

  it('prefers the federal Surveyor General record over the Ontario duplicate', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation');
    expect(candidates[0]?.sourceName).toBe('Aboriginal Lands of Canada Legislative Boundaries');
    // Both reserve records are still offered; ranking decides, it does not hide.
    const reserves = candidates.filter((c) => /parry island/i.test(c.officialName));
    expect(reserves.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reserves.map((c) => c.sourceName)).size).toBeGreaterThanOrEqual(2);
  });

  it('offers the census subdivision of the same name once the type hint is removed', () => {
    // "First Nation" in the prompt implies indian_reserve, which filters the census
    // record out. Without that hint all three records are on the table.
    const { candidates } = resolve(db, 'Parry Island');
    const sources = new Set(candidates.filter((c) => /parry island/i.test(c.officialName)).map((c) => c.sourceName));
    expect(sources.has('Census Subdivisions — 2021')).toBe(true);
  });

  it('works from the stripped form a hurried artist would type', () => {
    for (const q of ['parry island', 'Parry Island', 'PARRY ISLAND']) {
      expect(resolve(db, q).candidates[0]?.officialName.toUpperCase(), q).toBe('PARRY ISLAND FIRST NATION');
    }
  });

  it('survives a typo, which FTS5 alone cannot', () => {
    const { candidates } = resolve(db, 'Parrry Island First Nation');
    expect(candidates.slice(0, 3).some((c) => /parry island/i.test(c.officialName))).toBe(true);
  });

  it('explains why the top result ranked first', () => {
    const top = resolve(db, 'Parry Island First Nation').candidates[0]!;
    expect(top.justification).toContain('name match');
    expect(top.justification).toContain('authoritative');
  });

  it('does not fill the top five with near-miss islands when the name matched exactly', () => {
    // "Parry Island" is two edits from "Avery Island" and "Bare Island", both real
    // reserves. They must not crowd out the answer the artist actually asked for.
    const { candidates } = resolve(db, 'Parry Island First Nation');
    for (const c of candidates.slice(0, 5)) {
      expect(c.matchedVia, `${c.officialName} was a weak fuzzy hit`).not.toBe('fuzzy');
    }
  });

  it('still leans on fuzzy when nothing matched exactly', () => {
    const { candidates } = resolve(db, 'Wikwemikon Unceded');
    expect(candidates[0]?.officialName.toUpperCase()).toContain('WIKWEMIKONG');
  });

  it('never carries geometry into the candidate list', () => {
    for (const c of resolve(db, 'Parry Island First Nation').candidates) {
      expect(c).not.toHaveProperty('geometry');
    }
  });
});

describe('manual aliases', () => {
  it('finds Wasauksing, which appears in no official source', () => {
    // Before seeding, the community's own name returns nothing at all.
    expect(resolve(db, 'Wasauksing First Nation').candidates).toHaveLength(0);

    const result = applyManualAliases(db);
    invalidateFuzzyIndex();
    expect(result.inserted).toBeGreaterThan(0);

    const { candidates } = resolve(db, 'Wasauksing First Nation');
    expect(candidates[0]?.officialName.toUpperCase()).toBe('PARRY ISLAND FIRST NATION');
  });

  it('is idempotent, so it can run after every harvest', () => {
    applyManualAliases(db);
    const before = (db.prepare("SELECT COUNT(*) n FROM aliases WHERE alias_kind='manual'").get() as { n: number }).n;
    applyManualAliases(db);
    const after = (db.prepare("SELECT COUNT(*) n FROM aliases WHERE alias_kind='manual'").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('reports an entry whose target is missing instead of failing silently', () => {
    const result = applyManualAliases(db, [
      { aliases: ['Nowhere'], targetOfficialName: 'A Place That Does Not Exist', note: 'test' },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it('every shipped entry names a real feature in a realistic catalog', () => {
    // Guards against an entry rotting when a source renames something.
    const result = applyManualAliases(db);
    const targets = new Set(MANUAL_ALIASES.map((e) => e.targetOfficialName));
    // The fixture covers all four shipped targets, so nothing should be unmatched.
    expect(result.unmatched, `unmatched: ${JSON.stringify(result.unmatched)}`).toHaveLength(0);
    expect(targets.size).toBe(MANUAL_ALIASES.length);
  });
});

describe('hints and filters', () => {
  it('uses a type hint from the prompt to prefer the right kind of feature', () => {
    const { candidates } = resolve(db, 'the federal riding of Parry Sound—Muskoka');
    expect(candidates[0]?.featureType).toBe('federal_electoral_district');
    expect(candidates[0]?.officialName).toBe('Parry Sound--Muskoka');
  });

  it('matches a riding across the em dash / double hyphen difference between sources', () => {
    for (const q of ['Parry Sound—Muskoka', 'Parry Sound--Muskoka', 'parry sound muskoka']) {
      expect(resolve(db, q).candidates[0]?.officialName, q).toBe('Parry Sound--Muskoka');
    }
  });

  it('matches a French riding name', () => {
    expect(resolve(db, 'Thunder Bay—Supérieur-Nord').candidates[0]?.officialName).toBe(
      'Thunder Bay--Superior North',
    );
  });

  it('applies an explicit UI filter', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation', { featureTypeFilter: 'census_subdivision' });
    expect(candidates.every((c) => c.featureType === 'census_subdivision')).toBe(true);
  });

  it('drops a filter that would leave nothing, and says so', () => {
    // A wrong guess must not be able to hide the right answer entirely.
    const { candidates, notes } = resolve(db, 'Parry Island First Nation', { featureTypeFilter: 'airport' });
    expect(candidates.length).toBeGreaterThan(0);
    expect(notes.join(' ')).toMatch(/ignored/);
  });

  it('filters by jurisdiction when asked', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation', { jurisdictionFilter: 'ON' });
    expect(candidates.every((c) => c.jurisdiction === 'ON')).toBe(true);
  });
});

describe('result shape', () => {
  it('finds a name carrying extra words the official name lacks', () => {
    // "Six Nations of the Grand River" vs "SIX NATIONS INDIAN RESERVE NO. 40".
    const { candidates } = resolve(db, 'Six Nations of the Grand River');
    expect(candidates.slice(0, 3).some((c) => /six nations/i.test(c.officialName))).toBe(true);
  });

  it('returns each feature once, however many aliases matched', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation');
    expect(new Set(candidates.map((c) => c.featureId)).size).toBe(candidates.length);
  });

  it('honours the limit and reports timings', () => {
    const r = resolve(db, 'Parry Island First Nation', { limit: 2 });
    expect(r.candidates).toHaveLength(2);
    expect(r.timings.matchMs).toBeGreaterThanOrEqual(0);
  });

  it('returns nothing rather than guessing for an unknown place', () => {
    expect(resolve(db, 'Ouagadougou').candidates).toHaveLength(0);
  });

  it('returns nothing for empty input', () => {
    expect(resolve(db, '   ').candidates).toHaveLength(0);
  });

  it('scores every candidate between 0 and 1, best first', () => {
    const { candidates } = resolve(db, 'Parry Island First Nation');
    const scores = candidates.map((c) => c.matchScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
