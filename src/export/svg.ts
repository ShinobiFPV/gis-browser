import { bboxOf, fromWgs84, unionBbox, type Bbox, type Geometry } from '../harvester/normalize/crs';
import { projectionFor } from '@shared/projections';
import { closeRing, type Ring } from './winding';

/**
 * SVG for Illustrator and After Effects.
 *
 * Projection is not decoration here. Drawing lon/lat straight onto a canvas is a
 * Plate Carrée, which stretches Canada horizontally by roughly 1/cos(latitude) — about
 * 2x at 60°N and 3.7x at Nunavut's latitudes. An artist tracing that would produce a
 * visibly wrong country. So coordinates go through proj4 into a real projected CRS first,
 * and only then get fitted to the canvas.
 *
 * The Y axis is flipped on the way in: projected northings increase upward, SVG user units
 * increase downward.
 */

export interface SvgOptions {
  width: number;
  height: number;
  /** Uniform margin in pixels, inside the canvas. */
  padding: number;
  /** EPSG code from shared/projections. */
  srid: number;
  /** Decimal places on emitted path coordinates. Two is subpixel on an HD canvas. */
  precision: number;
  title: string;
  /** Credit line written into <desc>, so it travels with the file. */
  attribution: string;
  generatedBy: string;
  generatedAt: string;
}

export interface SvgFeatureInput {
  name: string;
  /** EPSG:4326, already simplified. */
  geometry: Geometry;
}

export interface SvgExport {
  text: string;
  /** Projected units (usually metres) per pixel. Recorded so the scale is reproducible. */
  unitsPerPixel: number;
  projectedBbox: Bbox | null;
  warnings: string[];
}

export const DEFAULT_SVG_PRECISION = 2;
export const DEFAULT_PADDING = 40;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Turns a boundary name into an id Illustrator will show as a layer name.
 *
 * XML ids may not begin with a digit and may not contain spaces. Uniqueness is enforced
 * with a numeric suffix rather than by trusting names to differ — "Sarnia 45" appears in
 * more than one source, and two identical ids would silently merge on import.
 */
export function toSvgId(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^(\d)/, 'n$1') || 'feature';

  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

function ringsOf(geometry: Geometry): Ring[] {
  switch (geometry.type) {
    case 'Polygon':
      return (geometry.coordinates as Ring[]).map(closeRing);
    case 'MultiPolygon':
      return (geometry.coordinates as Ring[][]).flatMap((poly) => poly.map(closeRing));
    case 'LineString':
      return [geometry.coordinates as Ring];
    case 'MultiLineString':
      return geometry.coordinates as Ring[];
    default:
      return [];
  }
}

export function buildSvg(inputs: SvgFeatureInput[], options: SvgOptions): SvgExport {
  const warnings: string[] = [];
  const projection = projectionFor(options.srid);

  const projected = inputs.map((f) => ({
    name: f.name,
    geometry: fromWgs84(f.geometry, options.srid, `SVG export of "${f.name}"`),
  }));

  let accumulated: Bbox | null = null;
  for (const f of projected) accumulated = unionBbox(accumulated, bboxOf(f.geometry));

  if (!accumulated) {
    throw new Error('Nothing to draw: none of the selected features produced any coordinates.');
  }
  // Bound to a const so the null check survives into the closures below.
  const extent: Bbox = accumulated;

  const drawableWidth = options.width - options.padding * 2;
  const drawableHeight = options.height - options.padding * 2;
  if (drawableWidth <= 0 || drawableHeight <= 0) {
    throw new Error(
      `Padding of ${options.padding}px leaves no room on a ${options.width}x${options.height} canvas.`,
    );
  }

  // A single-point or perfectly straight feature has zero extent on one axis. Fall back to
  // a 1-unit extent so the fit stays finite instead of dividing by zero.
  const spanX = extent.maxx - extent.minx || 1;
  const spanY = extent.maxy - extent.miny || 1;

  const scale = Math.min(drawableWidth / spanX, drawableHeight / spanY);
  const offsetX = (options.width - spanX * scale) / 2;
  const offsetY = (options.height - spanY * scale) / 2;

  const factor = 10 ** options.precision;
  const round = (n: number): number => Math.round(n * factor) / factor;
  const toX = (x: number): number => round(offsetX + (x - extent.minx) * scale);
  // Flip: the top of the canvas is the maximum northing.
  const toY = (y: number): number => round(offsetY + (extent.maxy - y) * scale);

  const taken = new Set<string>();
  const groups: string[] = [];

  for (const [i, f] of projected.entries()) {
    const rings = ringsOf(f.geometry);
    if (rings.length === 0) {
      warnings.push(`"${f.name}" has no drawable rings and was skipped.`);
      continue;
    }

    const subpaths: string[] = [];
    for (const ring of rings) {
      if (ring.length < 2) continue;
      const parts: string[] = [];
      for (const [j, point] of ring.entries()) {
        parts.push(`${j === 0 ? 'M' : 'L'}${toX(point[0] as number)},${toY(point[1] as number)}`);
      }
      // Z closes the subpath, so the duplicated final position is redundant. Dropping it
      // is safe for areas and wrong for lines, which are not closed.
      subpaths.push(parts.join('') + (f.geometry.type.includes('Polygon') ? 'Z' : ''));
    }

    if (subpaths.length === 0) {
      warnings.push(`"${f.name}" produced no path data and was skipped.`);
      continue;
    }

    const id = toSvgId(f.name, taken);
    groups.push(
      `    <g id="${id}" data-index="${i}">\n` +
        `      <title>${escapeXml(f.name)}</title>\n` +
        `      <path d="${subpaths.join(' ')}"/>\n` +
        `    </g>`,
    );
  }

  const desc = [
    options.attribution,
    `Projection: ${projection.code} (${projection.label}).`,
    `Fitted to ${options.width}x${options.height} with ${options.padding}px padding at ` +
      `${(1 / scale).toPrecision(6)} projected units per pixel.`,
    `Generated ${options.generatedAt} by ${options.generatedBy}.`,
  ]
    .filter(Boolean)
    .join(' ');

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" ` +
    `viewBox="0 0 ${options.width} ${options.height}">\n` +
    `  <title>${escapeXml(options.title)}</title>\n` +
    `  <desc>${escapeXml(desc)}</desc>\n` +
    // Styling lives on the parent group so the artist can restyle every boundary at once.
    // fill-rule is evenodd rather than nonzero so that holes stay holes the moment a fill
    // is applied — an enclave inside a riding must not fill solid.
    `  <g id="boundaries" fill="none" fill-rule="evenodd" stroke="#000000" stroke-width="2" ` +
    `stroke-linejoin="round" stroke-linecap="round">\n` +
    `${groups.join('\n')}\n` +
    `  </g>\n` +
    `</svg>\n`;

  return { text, unitsPerPixel: 1 / scale, projectedBbox: extent, warnings };
}
