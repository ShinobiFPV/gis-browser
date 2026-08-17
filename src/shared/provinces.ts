import type { Jurisdiction } from './taxonomy';

/**
 * Bounding box of every province and territory.
 *
 * Not typed in by hand: these were read out of the harvested Statistics Canada 2021
 * province/territory boundaries, so they are the same extents the rest of the catalog uses
 * rather than a second, subtly different set of numbers.
 *
 * Used by discovery to answer two questions about a candidate dataset:
 *
 *   1. Which jurisdiction is it about? An extent sitting inside Saskatchewan is a strong
 *      signal even when nothing in the title says so.
 *   2. Does it cover what it claims to? ArcGIS Hub is full of datasets titled "Provincial
 *      Electoral Districts" published by a single city, holding five of the province's
 *      hundred-odd ridings. Comparing the extent against the province catches those, and
 *      indexing one as if it were the provincial layer would put five fake ridings into a
 *      search that decides what goes on air.
 */
export interface LonLatBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export const PROVINCE_BBOX: Record<Jurisdiction, LonLatBox> = {
  AB: { minLon: -120.005, minLat: 48.994, maxLon: -109.995, maxLat: 60.005 },
  BC: { minLon: -139.057, minLat: 48.292, maxLon: -114.05, maxLat: 60.005 },
  MB: { minLon: -102.012, minLat: 48.994, maxLon: -88.975, maxLat: 60.005 },
  NB: { minLon: -69.055, minLat: 44.563, maxLon: -63.766, maxLat: 48.077 },
  NL: { minLon: -67.826, minLat: 46.606, maxLon: -52.614, maxLat: 60.381 },
  NS: { minLon: -66.4, minLat: 43.383, maxLon: -59.656, maxLat: 47.233 },
  NT: { minLon: -136.474, minLat: 59.995, maxLon: -101.995, maxLat: 78.81 },
  NU: { minLon: -120.73, minLat: 51.25, maxLon: -61.086, maxLat: 83.142 },
  ON: { minLon: -95.16, minLat: 41.676, maxLon: -74.339, maxLat: 56.865 },
  PE: { minLon: -64.418, minLat: 45.943, maxLon: -61.966, maxLat: 47.064 },
  QC: { minLon: -79.768, minLat: 44.986, maxLon: -57.103, maxLat: 62.587 },
  SK: { minLon: -110.015, minLat: 48.994, maxLon: -101.357, maxLat: 60.005 },
  YT: { minLon: -141.023, minLat: 59.995, maxLon: -123.784, maxLat: 69.652 },
  CA: { minLon: -141.5, minLat: 41.0, maxLon: -52.0, maxLat: 84.0 },
};

/** Province names and the common variants that appear in dataset titles. */
export const PROVINCE_ALIASES: Record<Jurisdiction, string[]> = {
  AB: ['alberta'],
  BC: ['british columbia', 'colombie-britannique'],
  MB: ['manitoba'],
  NB: ['new brunswick', 'nouveau-brunswick'],
  NL: ['newfoundland and labrador', 'newfoundland', 'labrador', 'terre-neuve'],
  NS: ['nova scotia', 'nouvelle-ecosse', 'nouvelle-écosse'],
  NT: ['northwest territories', 'territoires du nord-ouest'],
  NU: ['nunavut'],
  ON: ['ontario'],
  PE: ['prince edward island', 'ile-du-prince-edouard', 'île-du-prince-édouard'],
  QC: ['quebec', 'québec'],
  SK: ['saskatchewan'],
  YT: ['yukon'],
  CA: ['canada', 'canadian', 'federal', 'national'],
};

/**
 * Canada spans about 89 degrees of longitude and 43 of latitude. An extent materially
 * larger than that is not describing a Canadian dataset; it is a default nobody set.
 */
const MAX_PLAUSIBLE_LON_SPAN = 100;
const MAX_PLAUSIBLE_LAT_SPAN = 50;

/**
 * Rejects extents that cannot mean anything.
 *
 * ArcGIS Hub is full of them. The University of Illinois publishes "Minn 2022 Electoral
 * Districts" with an extent of -179.23..179.86 by -14.60..71.44 -- the whole planet --
 * and Fairbanks North Star Borough does the same. Treated as data, a world-sized extent
 * "covers" every province completely, so it silently passes every coverage check it
 * should fail. Treated as missing, which is what it is, the candidate correctly drops down
 * the list with "no extent published" against it.
 */
export function sanitiseExtent(box: LonLatBox | null): LonLatBox | null {
  if (!box) return null;

  const lonSpan = box.maxLon - box.minLon;
  const latSpan = box.maxLat - box.minLat;
  if (lonSpan <= 0 || latSpan <= 0) return null;
  if (lonSpan > MAX_PLAUSIBLE_LON_SPAN || latSpan > MAX_PLAUSIBLE_LAT_SPAN) return null;

  // Longitudes outside the real range, or a box straddling the antimeridian, are the same
  // kind of artefact.
  if (box.minLon < -180 || box.maxLon > 180 || box.minLat < -90 || box.maxLat > 90) return null;
  if (box.minLon < -179 && box.maxLon > 179) return null;

  return box;
}

export function areaOf(box: LonLatBox): number {
  return Math.max(0, box.maxLon - box.minLon) * Math.max(0, box.maxLat - box.minLat);
}

export function intersectionArea(a: LonLatBox, b: LonLatBox): number {
  const lon = Math.min(a.maxLon, b.maxLon) - Math.max(a.minLon, b.minLon);
  const lat = Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat);
  return lon <= 0 || lat <= 0 ? 0 : lon * lat;
}

/**
 * The jurisdiction whose extent best contains this box.
 *
 * Scored by how much of the CANDIDATE falls inside the province, not the reverse: a
 * dataset covering one city is entirely inside its province and should still be
 * attributed to it. Canada is only returned when no single province dominates, which is
 * what a genuinely national dataset looks like.
 */
export function jurisdictionForExtent(box: LonLatBox): { jurisdiction: Jurisdiction; containment: number } | null {
  const area = areaOf(box);
  if (area <= 0) return null;

  let best: { jurisdiction: Jurisdiction; containment: number } | null = null;
  for (const [code, province] of Object.entries(PROVINCE_BBOX) as [Jurisdiction, LonLatBox][]) {
    if (code === 'CA') continue;
    const containment = intersectionArea(box, province) / area;
    if (!best || containment > best.containment) best = { jurisdiction: code, containment };
  }

  if (!best || best.containment < 0.5) {
    // Spread across several provinces. National if most of it is inside Canada.
    const inCanada = intersectionArea(box, PROVINCE_BBOX.CA) / area;
    if (inCanada > 0.5) return { jurisdiction: 'CA', containment: inCanada };

    /*
     * Nothing dominates, so say so.
     *
     * Returning the least-bad province here was wrong and confidently wrong: an extent
     * covering half of North America was reported as Nunavut simply because Nunavut has
     * the largest bounding box of the thirteen. "I do not know" is a far more useful
     * answer to someone deciding whether to trust a boundary.
     */
    return null;
  }
  return best;
}

/**
 * How much of a jurisdiction a dataset's extent actually spans.
 *
 * A provincial electoral district layer should cover most of its province. The City of
 * Brampton's "Provincial Electoral Districts" covers 0.03% of Ontario and holds 5 of its
 * 124 ridings -- a municipal subset wearing a provincial title.
 */
export function coverageOf(box: LonLatBox, jurisdiction: Jurisdiction): number {
  const province = PROVINCE_BBOX[jurisdiction];
  const provinceArea = areaOf(province);
  return provinceArea <= 0 ? 0 : intersectionArea(box, province) / provinceArea;
}
