/**
 * Jurisdiction codes.
 *
 * Countries are ISO 3166-1 alpha-2 (`CA`, `US`, `FR`). Anything below a country is ISO
 * 3166-2, country-prefixed: `CA-ON`, `US-TX`.
 *
 * THE PREFIX IS NOT DECORATION. Until international support the catalog used bare
 * two-letter provincial codes, and five of the thirteen are also ISO 3166-1 codes for
 * somewhere else entirely:
 *
 *   NL   Newfoundland and Labrador   is also   Netherlands
 *   NU   Nunavut                     is also   Niue
 *   PE   Prince Edward Island        is also   Peru
 *   SK   Saskatchewan                is also   Slovakia
 *   YT   Yukon                       is also   Mayotte
 *
 * Sharing one namespace would not have failed; it would have quietly merged them. A
 * filter for the Netherlands would return Newfoundland's ridings, and a Yukon boundary
 * would answer to Mayotte. In an app whose whole job is putting the right shape on air,
 * that is the worst class of bug there is: no error, plausible output, wrong country.
 *
 * `CA` still means Canada, exactly as before. Only the subdivisions moved.
 */

/**
 * A jurisdiction code. Deliberately a plain string rather than a closed union.
 *
 * The old union of fourteen Canadian codes could be exhaustive because the world it
 * described was fixed. This one cannot: the set grows as countries are harvested, and the
 * authority on which codes exist is the catalog, not this file. Validation is by shape,
 * and labels come from the data -- see the `jurisdictions` table.
 */
export type Jurisdiction = string;

/** ISO 3166-1 alpha-2, optionally followed by an ISO 3166-2 subdivision suffix. */
const JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export function isJurisdiction(value: unknown): value is Jurisdiction {
  return typeof value === 'string' && JURISDICTION_RE.test(value);
}

/** Normalises case and separator. Returns null rather than guessing at nonsense. */
export function parseJurisdiction(raw: unknown): Jurisdiction | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[_\s]+/g, '-');
  return isJurisdiction(cleaned) ? cleaned : null;
}

export function isCountry(code: Jurisdiction): boolean {
  return code.length === 2;
}

/** `CA-ON` -> `CA`. A country code is its own country. */
export function countryOf(code: Jurisdiction): string {
  return code.slice(0, 2);
}

/** `CA-ON` -> `ON`, `CA` -> null. */
export function subdivisionOf(code: Jurisdiction): string | null {
  const dash = code.indexOf('-');
  return dash === -1 ? null : code.slice(dash + 1);
}

/**
 * Old bare code -> new prefixed code, for the schema migration and for reading anything
 * that was written down before the move (saved filters, a typed query, an export note).
 *
 * `CA` is absent on purpose: it meant Canada then and means Canada now.
 */
export const LEGACY_CANADIAN_CODES: Readonly<Record<string, Jurisdiction>> = {
  AB: 'CA-AB',
  BC: 'CA-BC',
  MB: 'CA-MB',
  NB: 'CA-NB',
  NL: 'CA-NL',
  NS: 'CA-NS',
  NT: 'CA-NT',
  NU: 'CA-NU',
  ON: 'CA-ON',
  PE: 'CA-PE',
  QC: 'CA-QC',
  SK: 'CA-SK',
  YT: 'CA-YT',
};

export interface LonLatBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * The Canadian provinces and territories, still hard-coded.
 *
 * These stay in the source because discovery needs them BEFORE anything is harvested --
 * it uses them to decide whether a candidate dataset is about Saskatchewan or is a
 * municipal subset wearing a provincial title. Every other jurisdiction's extent and
 * label is learned from harvested data instead, which is why there is no 250-country
 * table below: those names and boxes come from Natural Earth, and a list typed in from
 * memory would be a second, subtly different set of facts.
 *
 * Extents were read out of the harvested Statistics Canada 2021 boundaries.
 */
export const CANADA_SUBDIVISION_BBOX: Readonly<Record<Jurisdiction, LonLatBox>> = {
  'CA-AB': { minLon: -120.005, minLat: 48.994, maxLon: -109.995, maxLat: 60.005 },
  'CA-BC': { minLon: -139.057, minLat: 48.292, maxLon: -114.05, maxLat: 60.005 },
  'CA-MB': { minLon: -102.012, minLat: 48.994, maxLon: -88.975, maxLat: 60.005 },
  'CA-NB': { minLon: -69.055, minLat: 44.563, maxLon: -63.766, maxLat: 48.077 },
  'CA-NL': { minLon: -67.826, minLat: 46.606, maxLon: -52.614, maxLat: 60.381 },
  'CA-NS': { minLon: -66.4, minLat: 43.383, maxLon: -59.656, maxLat: 47.233 },
  'CA-NT': { minLon: -136.474, minLat: 59.995, maxLon: -101.995, maxLat: 78.81 },
  'CA-NU': { minLon: -120.73, minLat: 51.25, maxLon: -61.086, maxLat: 83.142 },
  'CA-ON': { minLon: -95.16, minLat: 41.676, maxLon: -74.339, maxLat: 56.865 },
  'CA-PE': { minLon: -64.418, minLat: 45.943, maxLon: -61.966, maxLat: 47.064 },
  'CA-QC': { minLon: -79.768, minLat: 44.986, maxLon: -57.103, maxLat: 62.587 },
  'CA-SK': { minLon: -110.015, minLat: 48.994, maxLon: -101.357, maxLat: 60.005 },
  'CA-YT': { minLon: -141.023, minLat: 59.995, maxLon: -123.784, maxLat: 69.652 },
  CA: { minLon: -141.5, minLat: 41.0, maxLon: -52.0, maxLat: 84.0 },
};

export const CANADA_SUBDIVISION_LABELS: Readonly<Record<Jurisdiction, string>> = {
  CA: 'Canada (federal)',
  'CA-AB': 'Alberta',
  'CA-BC': 'British Columbia',
  'CA-MB': 'Manitoba',
  'CA-NB': 'New Brunswick',
  'CA-NL': 'Newfoundland and Labrador',
  'CA-NS': 'Nova Scotia',
  'CA-NT': 'Northwest Territories',
  'CA-NU': 'Nunavut',
  'CA-ON': 'Ontario',
  'CA-PE': 'Prince Edward Island',
  'CA-QC': 'Quebec',
  'CA-SK': 'Saskatchewan',
  'CA-YT': 'Yukon',
};

/** Province names and the common variants that appear in dataset titles. */
export const CANADA_SUBDIVISION_ALIASES: Readonly<Record<Jurisdiction, string[]>> = {
  'CA-AB': ['alberta'],
  'CA-BC': ['british columbia', 'colombie-britannique'],
  'CA-MB': ['manitoba'],
  'CA-NB': ['new brunswick', 'nouveau-brunswick'],
  'CA-NL': ['newfoundland and labrador', 'newfoundland', 'labrador', 'terre-neuve'],
  'CA-NS': ['nova scotia', 'nouvelle-ecosse', 'nouvelle-écosse'],
  'CA-NT': ['northwest territories', 'territoires du nord-ouest'],
  'CA-NU': ['nunavut'],
  'CA-ON': ['ontario'],
  'CA-PE': ['prince edward island', 'ile-du-prince-edouard', 'île-du-prince-édouard'],
  'CA-QC': ['quebec', 'québec'],
  'CA-SK': ['saskatchewan'],
  'CA-YT': ['yukon'],
  CA: ['canada', 'canadian', 'federal', 'national'],
};

/**
 * A human label for a code, falling back to the code itself.
 *
 * Only Canada is known statically; everything else is labelled from the `jurisdictions`
 * registry at the point of use. Worth having anyway, because prefixing the codes made
 * every message that interpolated one read worse -- "0.0% of CA-ON" instead of "0.0% of
 * Ontario" -- and a reviewer reading a discovery concern should see the province.
 */
export function labelFor(code: Jurisdiction): string {
  return CANADA_SUBDIVISION_LABELS[code] ?? code;
}

/** Every Canadian code, federal first. */
export const CANADA_JURISDICTIONS: readonly Jurisdiction[] = [
  'CA',
  ...Object.keys(CANADA_SUBDIVISION_LABELS).filter((c) => c !== 'CA').sort(),
];

/**
 * Canada's rough lon/lat envelope. Harvested geometry outside this fails loudly for
 * Canadian sources -- it almost always means an unhandled CRS or a WFS 2.0 axis flip.
 */
export const CANADA_BBOX: LonLatBox = CANADA_SUBDIVISION_BBOX['CA']!;

/**
 * The whole planet, for sources that genuinely are worldwide.
 *
 * Latitude stops just short of the poles because Web Mercator does, and a source that
 * claims -90 is describing a default rather than a measurement.
 */
export const WORLD_BBOX: LonLatBox = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };
