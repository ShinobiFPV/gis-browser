import { describe, expect, it } from 'vitest';
import { buildAliases, kindForField, normalizeText, strippedVariants } from './aliases';

describe('normalizeText', () => {
  it('folds case and diacritics', () => {
    expect(normalizeText('Québec')).toBe('quebec');
    expect(normalizeText('MONTRÉAL')).toBe('montreal');
  });

  it('normalises every dash to a plain hyphen', () => {
    // Riding names use em dashes, which nobody types.
    expect(normalizeText('Parry Sound—Muskoka')).toBe('parry sound-muskoka');
    expect(normalizeText('Sudbury–Est')).toBe('sudbury-est');
    expect(normalizeText('a‐b')).toBe('a-b');
  });

  it('collapses the double hyphen StatCan uses to the single one Elections Canada implies', () => {
    // The same riding is "Parry Sound--Muskoka" at StatCan and "Parry Sound—Muskoka" at
    // Elections Canada. Both have to normalise to one string or the two sources never match.
    expect(normalizeText('Parry Sound--Muskoka')).toBe('parry sound-muskoka');
    expect(normalizeText('Parry Sound—Muskoka')).toBe('parry sound-muskoka');
    expect(normalizeText('Thunder Bay--Supérieur-Nord')).toBe('thunder bay-superieur-nord');
  });

  it('normalises curly apostrophes but keeps them', () => {
    expect(normalizeText("Taiaiako'n—Parkdale—High Park")).toBe("taiaiako'n-parkdale-high park");
    expect(normalizeText('Gwich’in Land')).toBe("gwich'in land");
  });

  it('collapses whitespace and drops stray punctuation', () => {
    expect(normalizeText('  St. Catharines  ')).toBe('st catharines');
  });
});

describe('strippedVariants', () => {
  it('keeps the full normalised form and strips the designation', () => {
    const v = strippedVariants('PARRY ISLAND FIRST NATION');
    expect(v).toContain('parry island first nation');
    expect(v).toContain('parry island');
  });

  it('strips leading administrative qualifiers', () => {
    expect(strippedVariants('City of Toronto')).toContain('toronto');
    expect(strippedVariants('Township of Georgian Bay')).toContain('georgian bay');
    expect(strippedVariants('The Regional Municipality of Peel')).toContain('peel');
  });

  it('offers a hyphen-free variant of compound riding names', () => {
    const v = strippedVariants('Parry Sound—Muskoka');
    expect(v).toContain('parry sound-muskoka');
    expect(v).toContain('parry sound muskoka');
  });

  it('strips reserve numbering while keeping the base name', () => {
    const v = strippedVariants('Shoal Lake Indian Reserve No. 39A');
    expect(v).toContain('shoal lake');
  });

  it('never strips a name down to nothing', () => {
    // "Nation" alone would otherwise strip to an empty string.
    for (const v of strippedVariants('Nation')) expect(v.length).toBeGreaterThanOrEqual(2);
  });

  it('returns nothing for empty input', () => {
    expect(strippedVariants('   ')).toEqual([]);
  });
});

describe('buildAliases', () => {
  it('emits the official name verbatim plus stripped forms', () => {
    const aliases = buildAliases('Parry Island First Nation', []);
    const byAlias = new Map(aliases.map((a) => [a.alias, a.kind]));
    expect(byAlias.get('Parry Island First Nation')).toBe('official');
    expect(byAlias.get('parry island first nation')).toBe('stripped');
    expect(byAlias.get('parry island')).toBe('stripped');
  });

  it('carries French names through with their own kind', () => {
    const aliases = buildAliases('Thunder Bay—Superior North', [
      { field: 'ED_NAMEF', value: 'Thunder Bay—Supérieur-Nord', kind: 'french' },
    ]);
    const fr = aliases.find((a) => a.alias === 'Thunder Bay—Supérieur-Nord');
    expect(fr?.kind).toBe('french');
    // And the accent-folded form is searchable.
    expect(aliases.some((a) => a.alias === 'thunder bay-superieur-nord')).toBe(true);
  });

  it('de-duplicates when two fields hold the same name, keeping the stronger kind', () => {
    // NRCan files Parry Island with identical English and French names.
    const aliases = buildAliases('PARRY ISLAND FIRST NATION', [
      { field: 'adminAreaNameFra', value: 'PARRY ISLAND FIRST NATION', kind: 'french' },
    ]);
    const hits = aliases.filter((a) => a.alias === 'PARRY ISLAND FIRST NATION');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('official');
  });

  it('ignores empty attribute values', () => {
    const aliases = buildAliases('Wikwemikong', [{ field: 'OTHER_NAME', value: '', kind: 'attribute' }]);
    expect(aliases.every((a) => a.alias.length >= 2)).toBe(true);
  });
});

describe('kindForField', () => {
  it('recognises French name fields', () => {
    expect(kindForField('ED_NAMEF')).toBe('french');
    expect(kindForField('MUNICIPAL_NAME_FR')).toBe('french');
    expect(kindForField('adminAreaNameFra')).toBe('french');
    expect(kindForField('PRFNAME')).toBe('attribute');
  });

  it('treats everything else as a plain attribute', () => {
    expect(kindForField('ED_NAMEE')).toBe('attribute');
    expect(kindForField('OFFICIAL_NAME')).toBe('attribute');
  });
});
