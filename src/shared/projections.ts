/**
 * Projections offered for SVG export.
 *
 * GeoJSON is always EPSG:4326 — RFC 7946 §4 permits no other CRS, and a file that claims
 * to be GeoJSON while carrying metres is the kind of thing that goes wrong quietly.
 * SVG has no CRS field at all, so the choice matters there and only there: the artist is
 * drawing a picture, and an unprojected lon/lat picture of Canada is visibly wrong —
 * Nunavut looks stretched to twice its width.
 *
 * Every code here must have a proj4 definition in harvester/normalize/crs.ts.
 */
export interface ProjectionChoice {
  srid: number;
  code: string;
  label: string;
  hint: string;
}

export const SVG_PROJECTIONS: ProjectionChoice[] = [
  {
    srid: 3347,
    code: 'EPSG:3347',
    label: 'Statistics Canada Lambert',
    hint: 'The national default. Matches every StatCan boundary product.',
  },
  {
    srid: 3978,
    code: 'EPSG:3978',
    label: 'Canada Atlas Lambert',
    hint: 'What Elections Canada and most federal atlas cartography use.',
  },
  {
    srid: 3005,
    code: 'EPSG:3005',
    label: 'BC Albers',
    hint: 'Correct for British Columbia. Distorts badly east of the Rockies.',
  },
  {
    srid: 3161,
    code: 'EPSG:3161',
    label: 'Ontario MNR Lambert',
    hint: 'Correct for Ontario. Distorts badly outside it.',
  },
  {
    srid: 3857,
    code: 'EPSG:3857',
    label: 'Web Mercator',
    hint: 'Matches online basemaps. Exaggerates the Arctic — avoid for anything north of 60.',
  },
  {
    srid: 4326,
    code: 'EPSG:4326',
    label: 'None — raw lon/lat',
    hint: 'Unprojected. Only for overlaying on something else already in lon/lat.',
  },
];

export const DEFAULT_SVG_SRID = 3347;

export function projectionFor(srid: number): ProjectionChoice {
  const found = SVG_PROJECTIONS.find((p) => p.srid === srid);
  if (!found) throw new Error(`EPSG:${srid} is not one of the offered SVG projections`);
  return found;
}
