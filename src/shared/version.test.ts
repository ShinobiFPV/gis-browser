import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer, parseVersion } from './version';

describe('parseVersion', () => {
  it('accepts a plain version and a git tag alike', () => {
    expect(parseVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: '' });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' });
  });

  it('keeps a prerelease tag', () => {
    expect(parseVersion('1.0.0-beta.2')?.prerelease).toBe('beta.2');
  });

  it('tolerates the four-part version Windows puts in file metadata', () => {
    // GIS Browser.exe reports 0.1.0.0. Comparing that against a 0.1.0 tag must not fail.
    expect(parseVersion('0.1.0.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: '' });
  });

  it('returns null for something that is not a version', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('compares numerically, not as text', () => {
    // The classic bug: "10" < "9" as strings, so 0.10.0 would look older than 0.9.0.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.100.0')).toBeGreaterThan(0);
  });

  it('sorts a prerelease before its release, per semver', () => {
    // Getting this backwards would offer a downgrade and call it an update.
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('treats an unreadable version as equal rather than newer', () => {
    // Offering an update on the strength of a string nobody can parse is worse than
    // staying quiet.
    expect(compareVersions('nonsense', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', 'nonsense')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is what the update check actually asks', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    // Against what Windows reports for the installed binary.
    expect(isNewer('0.1.0', '0.1.0.0')).toBe(false);
    expect(isNewer('0.2.0', '0.1.0.0')).toBe(true);
  });
});
