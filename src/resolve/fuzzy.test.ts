import { describe, expect, it } from 'vitest';
import { boundedLevenshtein, FuzzyIndex, maxDistanceFor, trigrams } from './fuzzy';

describe('boundedLevenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(boundedLevenshtein('parry island', 'parry island', 3)).toBe(0);
  });

  it('counts single edits', () => {
    expect(boundedLevenshtein('parry', 'parrry', 3)).toBe(1); // insertion
    expect(boundedLevenshtein('parry', 'pary', 3)).toBe(1); // deletion
    expect(boundedLevenshtein('parry', 'parey', 3)).toBe(1); // substitution
  });

  it('gives up once the bound cannot be met', () => {
    // The exact value past the bound does not matter, only that it exceeds it.
    expect(boundedLevenshtein('parry island', 'completely different', 3)).toBeGreaterThan(3);
  });

  it('rejects on length difference without doing the work', () => {
    expect(boundedLevenshtein('ab', 'abcdefghij', 2)).toBeGreaterThan(2);
  });

  it('handles empty strings', () => {
    expect(boundedLevenshtein('', 'abc', 5)).toBe(3);
    expect(boundedLevenshtein('abc', '', 5)).toBe(3);
    expect(boundedLevenshtein('', '', 5)).toBe(0);
  });

  it('is symmetric', () => {
    expect(boundedLevenshtein('wikwemikong', 'wikwemikon', 4)).toBe(
      boundedLevenshtein('wikwemikon', 'wikwemikong', 4),
    );
  });
});

describe('maxDistanceFor', () => {
  it('scales tolerance with query length', () => {
    expect(maxDistanceFor('bay')).toBe(1);
    expect(maxDistanceFor('sudbury')).toBe(2);
    expect(maxDistanceFor('parry island')).toBe(3);
    expect(maxDistanceFor('parry island first nation')).toBe(4);
  });
});

describe('trigrams', () => {
  it('pads so short strings still produce trigrams', () => {
    expect(trigrams('ab').length).toBeGreaterThan(0);
  });

  it('captures word starts', () => {
    expect(trigrams('parry')).toContain('  p');
  });
});

describe('FuzzyIndex', () => {
  const entries = [
    { aliasId: 1, featureId: 10, text: 'parry island first nation' },
    { aliasId: 2, featureId: 10, text: 'parry island' },
    { aliasId: 3, featureId: 11, text: 'parry sound-muskoka' },
    { aliasId: 4, featureId: 12, text: 'wikwemikong unceded reserve' },
    { aliasId: 5, featureId: 13, text: 'toronto centre' },
    { aliasId: 6, featureId: 14, text: 'thunder bay-superior north' },
    { aliasId: 7, featureId: 15, text: 'nunavut' },
  ];
  const index = new FuzzyIndex(entries);

  it('indexes every entry', () => {
    expect(index.size).toBe(entries.length);
  });

  it('finds an exact match with distance 0 and score 1', () => {
    const hit = index.search('parry island')[0]!;
    expect(hit.distance).toBe(0);
    expect(hit.score).toBe(1);
    expect(hit.featureId).toBe(10);
  });

  it('tolerates a typo FTS5 would miss entirely', () => {
    expect(index.search('parrry island')[0]?.featureId).toBe(10);
    expect(index.search('wikwemikon unceded reserve')[0]?.featureId).toBe(12);
    expect(index.search('toranto centre')[0]?.featureId).toBe(13);
  });

  it('tolerates a missing accent-folded hyphen', () => {
    expect(index.search('thunder bay superior north')[0]?.featureId).toBe(14);
  });

  it('returns nothing for a query with no plausible match', () => {
    expect(index.search('completely unrelated place name')).toEqual([]);
  });

  it('ignores queries too short to be meaningful', () => {
    expect(index.search('pa')).toEqual([]);
  });

  it('orders by edit distance, closest first', () => {
    const hits = index.search('parry islan');
    const distances = hits.map((h) => h.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it('honours the limit', () => {
    expect(index.search('parry island', { limit: 1 })).toHaveLength(1);
  });

  it('scores a short-name slip lower than the same slip on a long name', () => {
    // One edit out of seven characters hurts more than one out of twenty-five.
    const short = index.search('nunavu')[0]!;
    const long = index.search('parry island first natio')[0]!;
    expect(short.score).toBeLessThan(long.score);
  });

  it('copes with an empty index', () => {
    expect(new FuzzyIndex([]).search('anything')).toEqual([]);
  });

  it('stays fast on a realistically sized catalog', () => {
    // The live catalog has ~110,000 aliases; this must not be a per-keystroke stall.
    const many = Array.from({ length: 120_000 }, (_, i) => ({
      aliasId: i,
      featureId: i,
      text: `place name number ${i} in some province`,
    }));
    const big = new FuzzyIndex(many);
    const started = Date.now();
    const hits = big.search('place name number 4242 in some province');
    const elapsed = Date.now() - started;
    expect(hits[0]?.distance).toBe(0);
    expect(elapsed).toBeLessThan(1500);
  });
});
