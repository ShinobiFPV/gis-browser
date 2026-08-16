import { bboxOf, countVertices, unionBbox, type Bbox, type Geometry } from '../harvester/normalize/crs';
import { buildProvenance, serialiseSettings, type ExportSettings, type Provenance } from './provenance';
import { rewindGeometry, roundGeometry, validateGeometry } from './winding';
import type { FeatureRow, SourceRow } from '@shared/types';

/**
 * RFC 7946 GeoJSON.
 *
 * Three things the RFC requires that services routinely get wrong, and that we therefore
 * do here rather than trusting:
 *
 *   §4    CRS is always WGS 84 lon/lat. There is no crs member and no alternative. A
 *         projected "GeoJSON" is the single most common broken file in this domain.
 *   §3.1.6 Right-hand rule winding. ESRI's convention is the reverse of it.
 *   §5    bbox is [west, south, east, north].
 *
 * Foreign members (`_provenance`, `_export`) are explicitly permitted by §6 and are
 * ignored by every reader that does not want them.
 */

export const DEFAULT_PRECISION = 6;

export interface GeoJsonFeatureInput {
  feature: FeatureRow;
  source: SourceRow;
  /** Already simplified, in EPSG:4326. */
  geometry: Geometry;
  verticesBefore: number;
  sourceSrid: number | null;
  sourceGeneralisationDeg: number | null;
}

export interface GeoJsonExport {
  text: string;
  featureCount: number;
  bbox: Bbox | null;
  warnings: string[];
}

interface OutFeature {
  type: 'Feature';
  bbox?: number[];
  properties: Record<string, unknown>;
  geometry: Geometry;
}

/** Parses attributes_json defensively — a malformed blob must not sink the whole export. */
function attributesOf(feature: FeatureRow, warnings: string[]): Record<string, unknown> {
  if (!feature.attributes_json) return {};
  try {
    const parsed: unknown = JSON.parse(feature.attributes_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnings.push(`Attributes for "${feature.official_name}" were not a JSON object; omitted.`);
  } catch {
    warnings.push(`Attributes for "${feature.official_name}" could not be parsed; omitted.`);
  }
  return {};
}

export function buildGeoJson(
  inputs: GeoJsonFeatureInput[],
  settings: ExportSettings,
  precision = DEFAULT_PRECISION,
): GeoJsonExport {
  const warnings: string[] = [];
  const features: OutFeature[] = [];
  let collectionBbox: Bbox | null = null;

  for (const input of inputs) {
    // Rewind before rounding: rounding cannot flip a ring, but reversing after rounding
    // would mean the emitted coordinates were never the ones we validated.
    const wound = rewindGeometry(input.geometry);
    const rounded = roundGeometry(wound, precision);

    for (const problem of validateGeometry(rounded)) {
      warnings.push(`"${input.feature.official_name}": ${problem.detail}`);
    }

    const bbox = bboxOf(rounded);
    collectionBbox = unionBbox(collectionBbox, bbox);

    const attributes = attributesOf(input.feature, warnings);

    const provenance: Provenance = buildProvenance(
      input.feature,
      input.source,
      { before: input.verticesBefore, after: countVertices(rounded) },
      settings,
      input.sourceGeneralisationDeg,
      input.sourceSrid,
    );

    // The source's own attributes are written verbatim and never overwritten — provenance
    // matters, and an attribute the source calls "name" is its business, not ours. A `name`
    // convenience key is added only when nothing already occupies it, so labelling works
    // out of the box in QGIS without ever shadowing harvested data.
    const properties: Record<string, unknown> = { ...attributes };
    const hasName = Object.keys(attributes).some((k) => k.toLowerCase() === 'name');
    if (!hasName) properties['name'] = input.feature.official_name;
    properties['_provenance'] = provenance;

    features.push({
      type: 'Feature',
      ...(bbox ? { bbox: [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy] } : {}),
      properties,
      geometry: rounded,
    });
  }

  const collection = {
    type: 'FeatureCollection',
    ...(collectionBbox
      ? { bbox: [collectionBbox.minx, collectionBbox.miny, collectionBbox.maxx, collectionBbox.maxy] }
      : {}),
    _export: {
      ...serialiseSettings(settings),
      feature_count: features.length,
      note:
        'Coordinates are WGS 84 longitude/latitude per RFC 7946 §4. Rings follow the ' +
        'right-hand rule per §3.1.6. Per-feature history is under properties._provenance.',
    },
    features,
  };

  return {
    text: JSON.stringify(collection, null, 2) + '\n',
    featureCount: features.length,
    bbox: collectionBbox,
    warnings,
  };
}
