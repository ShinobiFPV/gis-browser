/**
 * Version comparison, for deciding whether a release is newer than what is running.
 *
 * Hand-rolled rather than pulling in semver: the only versions this ever compares are the
 * app's own, which are plain `major.minor.patch` with an optional prerelease tag. A
 * dependency for one twenty-line function is a poor trade, and this one is easy to test
 * exhaustively.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** e.g. 'beta.1' from 1.2.0-beta.1. Empty for a normal release. */
  prerelease: string;
}

/** Accepts an optional leading `v`, as git tags carry. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

/**
 * Returns >0 when a is newer than b, <0 when older, 0 when equal.
 *
 * A prerelease sorts BEFORE its release, per semver: 1.0.0-beta is older than 1.0.0.
 * Getting that backwards would offer someone a downgrade and call it an update.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  // An unparseable version is treated as equal rather than newer. Offering an update on
  // the strength of a version string nobody can read is worse than staying quiet.
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1; // a is the full release, b is a prerelease of it
  if (!pb.prerelease) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
