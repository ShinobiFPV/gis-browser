import { describe, expect, it } from 'vitest';
import { unpack, type PackedFeature, type PackedIndex, type PackedSource } from './catalog';
import { search } from './search';

/**
 * The mobile search layer, against a hand-built index.
 *
 * Built through `unpack` rather than by assembling a Catalog directly, so these tests also
 * pin the packed wire format. The tuples below and the ones written by
 * scripts/build-mobile-index.mjs are two halves of one format held together by nothing but
 * field order; reordering either without the other would produce a catalog whose features
 * had their type and jurisdiction swapped, and every one of these tests would still pass if
 * they only checked ranking.
 */

const SOURCES: PackedSource[] = [
  // Federal, authoritative for reserves.
  [1, 'NRCan CLSS Administrative Boundaries', 'esri-rest', 'https://example.test/clss', '0', 'OGL', 'Natural Resources Canada', '2025', 3979, null, '2026-08-16'],
  // Provincial, secondary for the same type.
  [2, 'Ontario LIO Open Data', 'esri-rest', 'https://example.test/lio', '3', 'OGL-ON', 'Queen’s Printer for Ontario', '2024', 3161, null, '2026-08-16'],
  // Elections Canada, multipart, authoritative for federal ridings.
  [3, 'Federal Electoral Districts — 2025', 'esri-rest', 'https://example.test/fed', '3', 'OGL', 'Elections Canada', '2025 general election', 3978, 'FED_NUM', '2026-08-16'],
];

function feature(
  id: number,
  name: string,
  typeIdx: number,
  jurIdx: number,
  sourceIdx: number,
  aliases: string[] = [],
): PackedFeature {
  return [id, name, typeIdx, jurIdx, sourceIdx, String(id), -80, 45, -79, 46, aliases];
}

const PACKED: PackedIndex = {
  format: 1,
  built: '2026-08-17',
  types: ['indian_reserve', 'federal_electoral_district', 'municipality'],
  jurisdictions: ['CA', 'CA-ON'],
  sources: SOURCES,
  jurisdictionLabels: { CA: 'Canada (federal)', 'CA-ON': 'Ontario' },
  features: [
    // "Parry Island" is a STRIPPED alias, the designation removed. The harvester writes one
    // of these for every name it ingests, and they are what the fuzzy pass mostly matches:
    // a typo in a long name is many edits from the long name and few from the short one.
    feature(1, 'PARRY ISLAND FIRST NATION', 0, 0, 0, [
      'Wasauksing First Nation',
      'Parry Island 16',
      'Parry Island',
    ]),
    feature(2, 'Parry Island First Nation', 0, 1, 1),
    feature(3, 'Parry Sound—Muskoka', 1, 0, 2),
    feature(4, 'SIX NATIONS INDIAN RESERVE NO. 40', 0, 0, 0),
    feature(5, 'Avery Island', 2, 1, 1),
    feature(6, 'Bare Island', 2, 1, 1),
    feature(7, 'Sarnia', 2, 1, 1),
    feature(8, 'SARNIA 45', 0, 0, 0),
  ],
};

const catalog = unpack(PACKED);

const names = (query: string, opts = {}): string[] =>
  search(catalog, query, opts).candidates.map((c) => c.feature.name);

describe('unpack', () => {
  it('reads the packed tuples in the order the generator writes them', () => {
    const parry = catalog.features.get(1);
    expect(parry?.name).toBe('PARRY ISLAND FIRST NATION');
    expect(parry?.featureType).toBe('indian_reserve');
    expect(parry?.jurisdiction).toBe('CA');
    expect(parry?.source.name).toBe('NRCan CLSS Administrative Boundaries');
    expect(parry?.source.srid).toBe(3979);
    expect(parry?.bbox).toEqual([-80, 45, -79, 46]);
  });

  it('carries the identity field, without which a multipart riding fetches as a fragment', () => {
    expect(catalog.features.get(3)?.source.identityField).toBe('FED_NUM');
    expect(catalog.features.get(1)?.source.identityField).toBeNull();
  });

  it('counts jurisdictions from the features that actually carry them', () => {
    expect(catalog.jurisdictions).toEqual([
      { code: 'CA', label: 'Canada (federal)', count: 4 },
      { code: 'CA-ON', label: 'Ontario', count: 4 },
    ]);
  });

  it('refuses an index written by a different format', () => {
    expect(() => unpack({ ...PACKED, format: 2 })).toThrow(/format 2 but this build expects 1/);
  });
});

describe('search', () => {
  it('finds an exactly typed name, whatever case the source filed it in', () => {
    expect(names('Parry Island First Nation').slice(0, 2)).toEqual([
      'PARRY ISLAND FIRST NATION',
      'Parry Island First Nation',
    ]);
  });

  it('prefers the authoritative source when two of them hold the same place', () => {
    const [first] = search(catalog, 'Parry Island First Nation').candidates;
    // Both are exact name matches, so only authority separates them: reserves are the
    // Surveyor General's, not Ontario's.
    expect(first?.feature.source.attribution).toBe('Natural Resources Canada');
  });

  it('narrows on a partial word, so the list moves while typing', () => {
    expect(names('parry isl')).toContain('PARRY ISLAND FIRST NATION');
  });

  it('reads a whole sentence through the shared parser', () => {
    const result = search(catalog, 'give me the outline shape for the federal riding of Parry Sound-Muskoka');
    expect(result.parsed.featureTypeHint).toBe('federal_electoral_district');
    expect(result.candidates[0]?.feature.name).toBe('Parry Sound—Muskoka');
  });

  it('matches an alias the official name does not contain', () => {
    expect(names('Wasauksing First Nation')[0]).toBe('PARRY ISLAND FIRST NATION');
  });

  it('rescues a typo through the fuzzy pass', () => {
    const result = search(catalog, 'Wikwemikong');
    expect(result.candidates).toEqual([]);

    // Two transposed letters. No token matches, so this can only come back through the
    // bounded Levenshtein pass -- which is the one that rescues a name nobody typed right.
    const typo = search(catalog, 'Parry Ilsand First Nation');
    expect(typo.candidates.map((c) => c.feature.name)).toContain('PARRY ISLAND FIRST NATION');
    expect(typo.candidates[0]?.matchedVia).toBe('fuzzy');
  });

  it('does not let near-miss islands crowd out an exact match', () => {
    // "Parry Island" is two edits from both "Avery Island" and "Bare Island". When the name
    // was typed correctly, those have nothing to offer.
    const found = names('Parry Island First Nation');
    expect(found).not.toContain('Avery Island');
    expect(found).not.toContain('Bare Island');
  });

  it('finds a name carrying words the official record does not have', () => {
    // The loose pass exists for exactly this: nobody files Six Nations under "Grand River".
    expect(names('Six Nations of the Grand River')).toContain('SIX NATIONS INDIAN RESERVE NO. 40');
  });

  it('keeps both Sarnias, so the artist picks the right one', () => {
    const found = names('Sarnia');
    expect(found).toContain('Sarnia');
    expect(found).toContain('SARNIA 45');
  });

  it('filters by type', () => {
    expect(names('Sarnia', { featureTypeFilter: 'indian_reserve' })).toEqual(['SARNIA 45']);
  });

  it('drops a filter that would empty the result, and says so', () => {
    const result = search(catalog, 'Parry Sound-Muskoka', { jurisdictionFilter: 'CA-ON' });
    expect(result.candidates[0]?.feature.name).toBe('Parry Sound—Muskoka');
    expect(result.notes).toContain('nothing matched the jurisdiction filter, so it was ignored');
  });

  it('returns nothing for a query too short to mean anything', () => {
    expect(search(catalog, 'a').candidates).toEqual([]);
  });
});
