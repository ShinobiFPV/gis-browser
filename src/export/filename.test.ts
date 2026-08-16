import { describe, expect, it } from 'vitest';
import { buildFilename, pluralise, slugify, uniquePath } from './filename';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('PARRY ISLAND FIRST NATION')).toBe('parry-island-first-nation');
  });

  it('strips diacritics', () => {
    expect(slugify('Rivière-du-Loup')).toBe('riviere-du-loup');
  });

  it('removes characters Windows will not accept in a filename', () => {
    expect(slugify('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('avoids reserved Windows device names', () => {
    expect(slugify('CON')).toBe('con-boundary');
    expect(slugify('lpt1')).toBe('lpt1-boundary');
  });

  it('never returns an empty string or a trailing hyphen', () => {
    expect(slugify('!!!')).toBe('boundary');
    expect(slugify('abcdefghij', 5)).toBe('abcde');
    expect(slugify('ab cdefghij', 3)).toBe('ab');
  });
});

describe('pluralise', () => {
  it('handles the endings the taxonomy actually produces', () => {
    expect(pluralise('province_territory')).toBe('province_territories');
    expect(pluralise('indian_reserve')).toBe('indian_reserves');
    expect(pluralise('census_tract')).toBe('census_tracts');
    expect(pluralise('watershed')).toBe('watersheds');
  });
});

describe('buildFilename', () => {
  it('names a single boundary after the place and its type', () => {
    expect(
      buildFilename({
        names: ['PARRY ISLAND FIRST NATION'],
        featureTypes: ['indian_reserve'],
        jurisdictions: ['ON'],
        extension: 'geojson',
        date: '2026-08-16',
      }),
    ).toBe('parry-island-first-nation_indian-reserve_2026-08-16.geojson');
  });

  it('describes a set by its shape rather than listing every name', () => {
    expect(
      buildFilename({
        names: Array.from({ length: 121 }, (_, i) => `Riding ${i}`),
        featureTypes: Array.from({ length: 121 }, () => 'federal_electoral_district'),
        jurisdictions: Array.from({ length: 121 }, () => 'ON'),
        extension: 'svg',
        date: '2026-08-16',
      }),
    ).toBe('121-federal-electoral-districts_on_2026-08-16.svg');
  });

  it('says boundaries when a set mixes types', () => {
    const name = buildFilename({
      names: ['A', 'B'],
      featureTypes: ['indian_reserve', 'census_subdivision'],
      jurisdictions: ['ON', 'ON'],
      extension: 'geojson',
      date: '2026-08-16',
    });
    expect(name).toBe('2-boundaries_on_2026-08-16.geojson');
  });

  it('omits the jurisdiction when a set spans more than one', () => {
    const name = buildFilename({
      names: ['A', 'B'],
      featureTypes: ['indian_reserve', 'indian_reserve'],
      jurisdictions: ['ON', 'BC'],
      extension: 'geojson',
      date: '2026-08-16',
    });
    expect(name).toBe('2-indian-reserves_2026-08-16.geojson');
  });

  it('refuses to name an empty export', () => {
    expect(() =>
      buildFilename({ names: [], featureTypes: [], jurisdictions: [], extension: 'svg', date: '2026-08-16' }),
    ).toThrow(/empty export/);
  });
});

describe('uniquePath', () => {
  const join = (a: string, b: string): string => `${a}\\${b}`;

  it('uses the plain name when nothing is in the way', () => {
    expect(uniquePath('C:\\out', 'a.geojson', () => false, join)).toBe('C:\\out\\a.geojson');
  });

  it('never overwrites: a second export of the same boundary gets its own file', () => {
    const existing = new Set(['C:\\out\\a.geojson', 'C:\\out\\a-2.geojson']);
    expect(uniquePath('C:\\out', 'a.geojson', (p) => existing.has(p), join)).toBe('C:\\out\\a-3.geojson');
  });

  it('keeps the extension when suffixing', () => {
    const existing = new Set(['C:\\out\\parry.svg']);
    expect(uniquePath('C:\\out', 'parry.svg', (p) => existing.has(p), join)).toMatch(/parry-2\.svg$/);
  });

  it('gives up rather than looping forever', () => {
    expect(() => uniquePath('C:\\out', 'a.geojson', () => true, join)).toThrow(/free filename/);
  });
});
