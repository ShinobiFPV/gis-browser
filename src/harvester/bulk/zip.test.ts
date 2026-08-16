import { describe, expect, it } from 'vitest';
import { isShapefilePart, safeJoin, UnsafeZipEntryError } from './zip';

/**
 * The zip-slip rule gets its own tests because the failure it prevents is invisible in
 * normal use: an archive with a hostile entry name extracts perfectly happily and writes
 * a file somewhere it should not. There is no output to notice.
 */
describe('safeJoin', () => {
  const target = process.platform === 'win32' ? 'C:\\work\\extract' : '/work/extract';

  it('resolves ordinary entries inside the target directory', () => {
    expect(safeJoin(target, 'lakes.shp')).toContain('lakes.shp');
    expect(safeJoin(target, 'nested/lakes.shp')).toContain('lakes.shp');
  });

  it('refuses an entry that climbs out with ..', () => {
    expect(() => safeJoin(target, '../escaped.txt')).toThrow(UnsafeZipEntryError);
    expect(() => safeJoin(target, 'a/../../escaped.txt')).toThrow(UnsafeZipEntryError);
    expect(() => safeJoin(target, '../../../../etc/passwd')).toThrow(UnsafeZipEntryError);
  });

  it('refuses an absolute entry name', () => {
    expect(() => safeJoin(target, '/etc/passwd')).toThrow(UnsafeZipEntryError);
    expect(() => safeJoin(target, 'C:/Windows/System32/evil.dll')).toThrow(UnsafeZipEntryError);
    expect(() => safeJoin(target, 'C:\\Windows\\evil.dll')).toThrow(UnsafeZipEntryError);
  });

  it('refuses backslash traversal, which Windows honours even though zip does not', () => {
    expect(() => safeJoin(target, '..\\escaped.txt')).toThrow(UnsafeZipEntryError);
    expect(() => safeJoin(target, 'a\\..\\..\\escaped.txt')).toThrow(UnsafeZipEntryError);
  });

  it('refuses an entry that resolves to the target directory itself', () => {
    expect(() => safeJoin(target, '.')).toThrow(UnsafeZipEntryError);
  });

  it('allows a name that merely starts with dots', () => {
    expect(() => safeJoin(target, '..leading.shp')).not.toThrow();
    expect(() => safeJoin(target, '.hidden/lakes.shp')).not.toThrow();
  });
});

describe('isShapefilePart', () => {
  it('keeps the parts a shapefile needs', () => {
    for (const name of ['a.shp', 'a.shx', 'a.dbf', 'a.prj', 'a.cpg']) {
      expect(isShapefilePart(name)).toBe(true);
    }
  });

  it('is case-insensitive, because archives are inconsistent about it', () => {
    // The Elections Canada archive ships FED_CA_2023_EN.CPG in caps beside a lowercase .dbf.
    expect(isShapefilePart('FED_CA_2023_EN.CPG')).toBe(true);
    expect(isShapefilePart('FED_CA_2023_EN.SHP')).toBe(true);
  });

  it('rejects the metadata that rides along', () => {
    for (const name of [
      'a.shp.xml', // ESRI metadata -- would otherwise match ".shp"
      'a.sbn',
      'a.sbx',
      'AL_TA_CA_2_187_ISO_eng.html',
      'AL_TA_CA_2_187_ISO_fra.xml',
      'ne_10m_lakes.README.html',
      'ne_10m_lakes.VERSION.txt',
    ]) {
      expect(isShapefilePart(name)).toBe(false);
    }
  });
});
