/**
 * Export filenames.
 *
 * Generated rather than asked for. The brief bans modal dialogs in the search-to-export
 * path, and a save dialog per export is the interruption it means — an artist pulling
 * twenty ridings before a bulletin should not name twenty files. The name is instead made
 * descriptive enough to find later without opening it.
 *
 *   parry-island-first-nation_indian-reserve_2026-08-16.geojson
 *   12-federal-electoral-districts_ON_2026-08-16.svg
 */

/**
 * Names Windows reserves regardless of extension.
 *
 * Everything else dangerous in a filename — the <>:"/\|?* set, control characters,
 * trailing dots and spaces — is already gone by the time this is consulted, because
 * slugify collapses everything to [a-z0-9-]. There is no second blocklist to keep in sync.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  if (!slug) return 'boundary';
  return RESERVED.has(slug) ? `${slug}-boundary` : slug;
}

/**
 * Pluralises a feature_type for a filename.
 *
 * Only the endings the taxonomy actually produces are handled — "province_territory"
 * becomes "province-territories", not "province-territorys". Anything unrecognised just
 * takes an -s, which is correct for every remaining type in the vocabulary.
 */
export function pluralise(featureType: string): string {
  if (/y$/.test(featureType)) return `${featureType.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(featureType)) return `${featureType}es`;
  return `${featureType}s`;
}

export interface NameParts {
  /** Every feature in the export, in order. */
  names: string[];
  featureTypes: string[];
  jurisdictions: (string | null)[];
  extension: 'geojson' | 'svg';
  /** ISO date, already local to the user. */
  date: string;
}

export function buildFilename(parts: NameParts): string {
  const { names, featureTypes, jurisdictions, extension, date } = parts;

  if (names.length === 0) throw new Error('Cannot build a filename for an empty export');

  const uniqueTypes = [...new Set(featureTypes)];
  const uniqueJurisdictions = [...new Set(jurisdictions.filter((j): j is string => !!j))];

  let stem: string;
  if (names.length === 1) {
    stem = [slugify(names[0]!), slugify(uniqueTypes[0] ?? '')].filter(Boolean).join('_');
  } else {
    // A set is described by its shape, not by listing twenty names.
    const type = uniqueTypes.length === 1 ? slugify(pluralise(uniqueTypes[0]!)) : 'boundaries';
    const where = uniqueJurisdictions.length === 1 ? slugify(uniqueJurisdictions[0]!) : '';
    stem = [`${names.length}-${type}`, where].filter(Boolean).join('_');
  }

  return `${stem}_${date}.${extension}`;
}

/**
 * Appends -2, -3, ... until the name is free.
 *
 * Never overwrites. An artist who exports the same riding twice at different
 * simplifications must end up with two files, not one silently replaced — the second
 * export is usually the one being compared against the first.
 */
export function uniquePath(
  folder: string,
  filename: string,
  exists: (path: string) => boolean,
  join: (a: string, b: string) => string,
): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);

  let candidate = join(folder, filename);
  let n = 2;
  while (exists(candidate)) {
    candidate = join(folder, `${stem}-${n}${ext}`);
    n++;
    if (n > 9999) throw new Error(`Cannot find a free filename for ${filename} in ${folder}`);
  }
  return candidate;
}
