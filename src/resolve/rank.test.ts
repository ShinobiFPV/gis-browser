import { describe, expect, it } from 'vitest';
import { aliasKindScore, authorityOf, authorityScore, explain, scoreCandidate, type ScoreInput } from './rank';

const NRCAN = { jurisdiction: 'CA', attribution: 'Natural Resources Canada, Surveyor General Branch', vintage: 'CLSS current' };
const STATCAN = { jurisdiction: 'CA', attribution: 'Statistics Canada, 2021 Census — Cartographic Boundary Files', vintage: '2021 census' };
const ELECTIONS = { jurisdiction: 'CA', attribution: 'Elections Canada', vintage: '2023 representation order' };
const ONTARIO = { jurisdiction: 'ON', attribution: '© King’s Printer for Ontario', vintage: 'LIO current' };

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    featureType: 'indian_reserve',
    jurisdiction: 'ON',
    source: NRCAN,
    aliasKind: 'official',
    nameScore: 1,
    exact: true,
    featureTypeHint: null,
    jurisdictionHint: null,
    vintageHint: null,
    ...over,
  };
}

describe('authorityOf', () => {
  it('classifies each seeded source family', () => {
    expect(authorityOf(NRCAN)).toBe('federal');
    expect(authorityOf(STATCAN)).toBe('statcan');
    expect(authorityOf(ELECTIONS)).toBe('elections');
    expect(authorityOf(ONTARIO)).toBe('provincial');
  });

  it('returns null when it cannot tell', () => {
    expect(authorityOf({ jurisdiction: 'CA', attribution: 'Somebody', vintage: null })).toBeNull();
  });
});

describe('authorityScore', () => {
  it('prefers the federal Surveyor General for reserves', () => {
    // The brief's rule, verbatim: federal for reserves.
    expect(authorityScore('indian_reserve', NRCAN)).toBe(1);
    expect(authorityScore('indian_reserve', ONTARIO)).toBeLessThan(1);
    expect(authorityScore('indian_reserve', STATCAN)).toBeLessThan(1);
  });

  it('prefers StatCan for census geography', () => {
    expect(authorityScore('census_subdivision', STATCAN)).toBe(1);
    expect(authorityScore('census_subdivision', ONTARIO)).toBeLessThan(1);
  });

  it('prefers Elections Canada for federal ridings over StatCan’s republication', () => {
    expect(authorityScore('federal_electoral_district', ELECTIONS)).toBe(1);
    expect(authorityScore('federal_electoral_district', STATCAN)).toBeLessThan(1);
  });

  it('prefers the province for provincial layers', () => {
    expect(authorityScore('provincial_electoral_district', ONTARIO)).toBe(1);
    expect(authorityScore('municipality', ONTARIO)).toBe(1);
    expect(authorityScore('municipality', STATCAN)).toBeLessThan(1);
  });

  it('is neutral for a type with no declared authority', () => {
    expect(authorityScore('airport', ONTARIO)).toBeGreaterThan(0);
  });
});

describe('aliasKindScore', () => {
  it('ranks official above derived forms', () => {
    expect(aliasKindScore('official')).toBeGreaterThan(aliasKindScore('attribute'));
    expect(aliasKindScore('attribute')).toBeGreaterThan(aliasKindScore('stripped'));
    expect(aliasKindScore(null)).toBeLessThan(aliasKindScore('stripped'));
  });
});

describe('scoreCandidate', () => {
  it('puts the authoritative source ahead of a duplicate of the same feature elsewhere', () => {
    // Parry Island really is in all three of these, as the same reserve.
    const federal = scoreCandidate(input({ featureType: 'indian_reserve', source: NRCAN }));
    const provincial = scoreCandidate(input({ featureType: 'indian_reserve', source: ONTARIO }));
    const census = scoreCandidate(input({ featureType: 'indian_reserve', source: STATCAN }));
    expect(federal.total).toBeGreaterThan(provincial.total);
    expect(federal.total).toBeGreaterThan(census.total);
  });

  it('lets each source win for the type it is authoritative for', () => {
    // StatCan is not second-best at census subdivisions just because NRCan owns reserves.
    const nrcanReserve = scoreCandidate(input({ featureType: 'indian_reserve', source: NRCAN }));
    const statcanCsd = scoreCandidate(input({ featureType: 'census_subdivision', source: STATCAN }));
    expect(statcanCsd.total).toBe(nrcanReserve.total);
  });

  it('never lets authority outweigh a genuinely better name match', () => {
    // The wrong feature from the right source must not beat the right feature.
    const rightNameWrongSource = scoreCandidate(input({ source: ONTARIO, exact: true, nameScore: 1 }));
    const wrongNameRightSource = scoreCandidate(input({ source: NRCAN, exact: false, nameScore: 0.45 }));
    expect(rightNameWrongSource.total).toBeGreaterThan(wrongNameRightSource.total);
  });

  it('rewards a matching type hint and penalises a contradicting one', () => {
    const matching = scoreCandidate(input({ featureTypeHint: 'indian_reserve' }));
    const contradicting = scoreCandidate(input({ featureTypeHint: 'census_division' }));
    const none = scoreCandidate(input({ featureTypeHint: null }));
    expect(matching.total).toBeGreaterThan(none.total);
    expect(none.total).toBeGreaterThan(contradicting.total);
  });

  it('treats a contradicting hint as a preference, not a veto', () => {
    // The keyword parser guesses; a wrong guess must not zero out a perfect name match.
    const contradicted = scoreCandidate(input({ featureTypeHint: 'census_division', exact: true }));
    const weakButConsistent = scoreCandidate(
      input({ featureTypeHint: 'indian_reserve', exact: false, nameScore: 0.3 }),
    );
    expect(contradicted.total).toBeGreaterThan(weakButConsistent.total);
  });

  it('rewards a jurisdiction and vintage match', () => {
    expect(scoreCandidate(input({ jurisdictionHint: 'ON' })).total).toBeGreaterThan(
      scoreCandidate(input({ jurisdictionHint: 'BC' })).total,
    );
    expect(
      scoreCandidate(input({ source: ELECTIONS, featureType: 'federal_electoral_district', vintageHint: '2023' }))
        .total,
    ).toBeGreaterThan(
      scoreCandidate(input({ source: STATCAN, featureType: 'federal_electoral_district', vintageHint: '2023' }))
        .total,
    );
  });

  it('keeps the total within 0..1', () => {
    const best = scoreCandidate(
      input({ featureTypeHint: 'indian_reserve', jurisdictionHint: 'ON', vintageHint: 'CLSS' }),
    );
    const worst = scoreCandidate(
      input({
        source: { jurisdiction: null, attribution: null, vintage: null },
        aliasKind: null,
        exact: false,
        nameScore: 0,
        featureTypeHint: 'airport',
        jurisdictionHint: 'BC',
        vintageHint: '1999',
      }),
    );
    expect(best.total).toBeLessThanOrEqual(1);
    expect(worst.total).toBeGreaterThanOrEqual(0);
    expect(best.total).toBeGreaterThan(worst.total);
  });
});

describe('explain', () => {
  it('says why a candidate ranked where it did', () => {
    const b = scoreCandidate(input({ featureTypeHint: 'indian_reserve', jurisdictionHint: 'ON' }));
    const text = explain('indian_reserve', NRCAN, b);
    expect(text).toContain('exact name match');
    expect(text).toContain('authoritative source');
    expect(text).toContain('type matches');
  });

  it('flags a secondary source rather than staying silent about it', () => {
    const b = scoreCandidate(input({ source: ONTARIO }));
    expect(explain('indian_reserve', ONTARIO, b)).toContain('secondary source');
  });
});
