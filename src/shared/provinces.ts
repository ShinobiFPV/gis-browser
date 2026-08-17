import {
  CANADA_SUBDIVISION_ALIASES,
  CANADA_SUBDIVISION_BBOX,
  type Jurisdiction,
  type LonLatBox,
} from './jurisdictions';

/**
 * Canadian extent scoring for discovery.
 *
 * DELIBERATELY STILL CANADA-ONLY. The discovery crawlers search Canadian catalogs --
 * provincial ArcGIS Hub sites and CKAN portals -- and these functions answer two
 * questions about a candidate found there:
 *
 *   1. Which jurisdiction is it about? An extent sitting inside Saskatchewan is a strong
 *      signal even when nothing in the title says so.
 *   2. Does it cover what it claims to? ArcGIS Hub is full of datasets titled "Provincial
 *      Electoral Districts" published by a single city, holding five of the province's
 *      hundred-odd ridings. Comparing the extent against the province catches those, and
 *      indexing one as if it were the provincial layer would put five fake ridings into a
 *      search that decides what goes on air.
 *
 * International sources are seeded explicitly with a verified endpoint and a known
 * jurisdiction, so none of this guessing applies to them. Generalising these heuristics
 * worldwide would mean inventing extents for 200 countries; the honest version of that
 * is to learn each country's extent from its harvested boundary, which is what the
 * `jurisdictions` registry does.
 */

export type { LonLatBox };

/** Re-keyed to ISO 3166-2 (`CA-ON`). See ./jurisdictions for why the prefix exists. */
export const PROVINCE_BBOX = CANADA_SUBDIVISION_BBOX;
export const PROVINCE_ALIASES = CANADA_SUBDIVISION_ALIASES;

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
 * The Canadian jurisdiction whose extent best contains this box.
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
  for (const [code, province] of Object.entries(PROVINCE_BBOX)) {
    if (code === 'CA') continue;
    const containment = intersectionArea(box, province) / area;
    if (!best || containment > best.containment) best = { jurisdiction: code, containment };
  }

  const canada = PROVINCE_BBOX['CA']!;
  if (!best || best.containment < 0.5) {
    // Spread across several provinces. National if most of it is inside Canada.
    const inCanada = intersectionArea(box, canada) / area;
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
 *
 * Zero for a jurisdiction with no hard-coded extent, which is every non-Canadian one:
 * an unknown extent must not read as full coverage.
 */
export function coverageOf(box: LonLatBox, jurisdiction: Jurisdiction): number {
  const province = PROVINCE_BBOX[jurisdiction];
  if (!province) return 0;
  const provinceArea = areaOf(province);
  return provinceArea <= 0 ? 0 : intersectionArea(box, province) / provinceArea;
}
