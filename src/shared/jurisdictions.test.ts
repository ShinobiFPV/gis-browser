import { describe, expect, it } from 'vitest';
import {
  CANADA_SUBDIVISION_BBOX,
  CANADA_SUBDIVISION_LABELS,
  countryOf,
  isCountry,
  isJurisdiction,
  labelFor,
  LEGACY_CANADIAN_CODES,
  parseJurisdiction,
  subdivisionOf,
} from './jurisdictions';

describe('jurisdiction codes', () => {
  it('accepts a country and a subdivision', () => {
    expect(isJurisdiction('CA')).toBe(true);
    expect(isJurisdiction('US')).toBe(true);
    expect(isJurisdiction('CA-ON')).toBe(true);
    expect(isJurisdiction('US-TX')).toBe(true);
  });

  it('rejects things that are not codes', () => {
    expect(isJurisdiction('Ontario')).toBe(false);
    expect(isJurisdiction('ca-on')).toBe(false); // case matters; parseJurisdiction normalises
    expect(isJurisdiction('C')).toBe(false);
    expect(isJurisdiction('')).toBe(false);
    expect(isJurisdiction(null)).toBe(false);
  });

  it('normalises case and separators when parsing', () => {
    expect(parseJurisdiction('ca-on')).toBe('CA-ON');
    expect(parseJurisdiction(' us_tx ')).toBe('US-TX');
    expect(parseJurisdiction('Ontario')).toBeNull();
  });

  it('splits a code into country and subdivision', () => {
    expect(countryOf('CA-ON')).toBe('CA');
    expect(countryOf('CA')).toBe('CA');
    expect(subdivisionOf('US-TX')).toBe('TX');
    expect(subdivisionOf('US')).toBeNull();
    expect(isCountry('US')).toBe(true);
    expect(isCountry('US-TX')).toBe(false);
  });
});

describe('the collision this prefix exists to prevent', () => {
  /*
   * These five bare codes each named a Canadian province before the catalog went
   * international, and each is also the ISO 3166-1 code for a different country. Sharing
   * one namespace would not have errored -- it would have merged them.
   */
  const COLLISIONS: [string, string][] = [
    ['NL', 'Netherlands'],
    ['NU', 'Niue'],
    ['PE', 'Peru'],
    ['SK', 'Slovakia'],
    ['YT', 'Mayotte'],
  ];

  it('leaves every colliding bare code free for the country', () => {
    for (const [code] of COLLISIONS) {
      // The Canadian meaning lives at CA-XX...
      expect(CANADA_SUBDIVISION_LABELS[`CA-${code}`]).toBeDefined();
      // ...and the bare code is not claimed by Canada at all.
      expect(CANADA_SUBDIVISION_LABELS[code]).toBeUndefined();
    }
  });

  it('maps every legacy code to its prefixed form', () => {
    expect(Object.keys(LEGACY_CANADIAN_CODES)).toHaveLength(13);
    for (const [bare, prefixed] of Object.entries(LEGACY_CANADIAN_CODES)) {
      expect(prefixed).toBe(`CA-${bare}`);
      expect(CANADA_SUBDIVISION_LABELS[prefixed]).toBeDefined();
    }
    // CA is absent: it meant Canada before and means Canada now.
    expect(LEGACY_CANADIAN_CODES['CA']).toBeUndefined();
  });
});

describe('labelFor', () => {
  it('names a Canadian code', () => {
    expect(labelFor('CA-ON')).toBe('Ontario');
    expect(labelFor('CA')).toBe('Canada (federal)');
  });

  it('falls back to the code for anything it does not know', () => {
    // Non-Canadian labels come from the registry, not from here.
    expect(labelFor('US-TX')).toBe('US-TX');
    expect(labelFor('FR')).toBe('FR');
  });
});

describe('the Canadian tables', () => {
  it('agree on which codes exist', () => {
    expect(Object.keys(CANADA_SUBDIVISION_BBOX).sort()).toEqual(Object.keys(CANADA_SUBDIVISION_LABELS).sort());
  });

  it('are all prefixed except CA itself', () => {
    for (const code of Object.keys(CANADA_SUBDIVISION_LABELS)) {
      if (code === 'CA') continue;
      expect(code.startsWith('CA-')).toBe(true);
      expect(isJurisdiction(code)).toBe(true);
    }
  });
});
