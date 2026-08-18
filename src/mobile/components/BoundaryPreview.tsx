import { useMemo } from 'react';
import type { Geometry } from '../../harvester/normalize/crs';

interface Props {
  geometry: Geometry | null;
  /** Drawn as a dashed rectangle when there is no geometry yet, so the list still locates. */
  bbox: [number, number, number, number] | null;
  /** The viewBox, not a pixel size -- the SVG is scaled to its container by the stylesheet. */
  width?: number;
  height?: number;
}

/**
 * The boundary itself, drawn as an SVG path.
 *
 * The desktop previews in maplibre, which is the right tool there: pan, zoom, a real
 * projection engine. It is 900 KB of JavaScript plus a web worker, and the budget for this
 * build is a phone on a newsroom LTE connection. What a preview is actually FOR here is
 * confirming the right shape came back before it is exported -- is this Sarnia the city or
 * Sarnia No. 221 -- and an outline fitted to a box answers that completely.
 *
 * The fit is equirectangular with a cos(latitude) correction on x. That is not a projection
 * anyone should export -- the SVG exporter goes through proj4 into a real projected CRS for
 * exactly that reason -- but for a thumbnail it puts the shape at roughly the right aspect
 * ratio, which unprojected lon/lat does not: Nunavut drawn raw is twice as wide as it is.
 *
 * Nothing here is measured in pixels. The viewBox is a coordinate space and the container
 * decides how big it is drawn, so the outline fits whatever room a phone has -- and because
 * the fit leaves the shape inside the box with padding to spare, "fits" never means "clipped".
 */
export function BoundaryPreview({ geometry, bbox, width = 320, height = 220 }: Props): React.JSX.Element {
  const path = useMemo(() => (geometry ? buildPath(geometry, width, height) : null), [geometry, width, height]);

  return (
    <svg
      className="preview"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={geometry ? 'Boundary outline' : 'No boundary loaded'}
    >
      {path ? (
        <path d={path} className="preview-shape" />
      ) : (
        <text x={width / 2} y={height / 2} className="preview-empty" textAnchor="middle">
          {bbox ? 'no boundary loaded' : 'no extent indexed'}
        </text>
      )}
    </svg>
  );
}

type Ring = number[][];

function ringsOf(geometry: Geometry): Ring[] {
  switch (geometry.type) {
    case 'Polygon':
      return geometry.coordinates as Ring[];
    case 'MultiPolygon':
      return (geometry.coordinates as Ring[][]).flat();
    case 'LineString':
      return [geometry.coordinates as Ring];
    case 'MultiLineString':
      return geometry.coordinates as Ring[];
    default:
      return [];
  }
}

/**
 * Every ring in one path string.
 *
 * One `d` rather than one element per ring: Quebec is over twenty thousand separate
 * polygons, and twenty thousand DOM nodes is a locked-up phone. Rings sub-pixel at this
 * size are dropped before they are written out, which is a drawing decision and touches
 * nothing that gets exported.
 */
function buildPath(geometry: Geometry, width: number, height: number): string | null {
  const rings = ringsOf(geometry);
  if (rings.length === 0) return null;

  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      const x = p[0]!;
      const y = p[1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  }
  if (!Number.isFinite(minx)) return null;

  // A degree of longitude is cos(latitude) as wide as a degree of latitude. Without this a
  // northern boundary is drawn stretched sideways -- about 2x at 60°N.
  const midLat = ((miny + maxy) / 2) * (Math.PI / 180);
  const lonScale = Math.max(0.05, Math.cos(midLat));

  const spanX = (maxx - minx) * lonScale || 1e-9;
  const spanY = maxy - miny || 1e-9;

  const padding = 10;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  const toX = (lon: number): number => offsetX + (lon - minx) * lonScale * scale;
  // Flipped: latitude increases upward, SVG user units increase downward.
  const toY = (lat: number): number => offsetY + (maxy - lat) * scale;

  const closed = geometry.type.includes('Polygon');
  const out: string[] = [];

  for (const ring of rings) {
    if (ring.length < 2) continue;

    const parts: string[] = [];
    let lastX = NaN;
    let lastY = NaN;
    for (const point of ring) {
      const x = Math.round(toX(point[0]!) * 10) / 10;
      const y = Math.round(toY(point[1]!) * 10) / 10;
      // Consecutive vertices landing on the same tenth of a pixel add path data nobody can
      // see. On a 200,000-vertex coastline that is most of them.
      if (x === lastX && y === lastY) continue;
      parts.push(`${parts.length === 0 ? 'M' : 'L'}${x},${y}`);
      lastX = x;
      lastY = y;
    }

    if (parts.length < 2) continue;
    out.push(parts.join('') + (closed ? 'Z' : ''));
  }

  return out.length > 0 ? out.join(' ') : null;
}
