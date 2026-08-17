import { buildGeoJson, DEFAULT_PRECISION } from '@export/geojson';
import { buildFilename } from '@export/filename';
import { attributionLine, licenceLines, type ExportSettings } from '@export/provenance';
import { buildSvg, DEFAULT_PADDING, DEFAULT_SVG_PRECISION } from '@export/svg';
import { DEFAULT_SVG_SRID } from '@shared/projections';
import type { FeatureRow, SourceRow } from '@shared/types';
import type { Geometry } from '../../harvester/normalize/crs';
import type { MobileFeature } from './catalog';

/**
 * Export, from a phone.
 *
 * Every byte of the file's structure -- RFC 7946 winding, the `_provenance` block, the
 * projected SVG, the generated filename -- comes from the same modules the desktop uses.
 * That is the whole reason the mobile build is a second Vite config rather than a second
 * package: a GeoJSON exported here and one exported on the desktop have to be the same
 * file, and two copies of the export layer would be two chances for them not to be.
 *
 * One thing is genuinely missing, and it is missing rather than approximated:
 * SIMPLIFICATION. The desktop hands a whole export to mapshaper at once so that two ridings
 * sharing a border share the same simplified arc. mapshaper is a Node program, and a
 * per-feature simplifier written to replace it would produce exactly the hairline seams
 * that the shared-topology pass exists to prevent -- on a broadcast map, at the moment the
 * wipe lands on it. So mobile exports are full resolution, and the UI says so.
 */

export type ExportFormat = 'geojson' | 'svg';

export interface ExportInput {
  feature: MobileFeature;
  geometry: Geometry;
  vertexCount: number;
  generalisationDeg: number | null;
}

export interface ExportedFile {
  filename: string;
  text: string;
  mimeType: string;
  bytes: number;
  warnings: string[];
  /** The credit line, ready to paste into a lower third. */
  attribution: string;
  licences: string[];
}

/** __APP_VERSION__ is stamped in by Vite; see vite.mobile.config.ts and types/build-constants.d.ts. */
const GENERATED_BY = `GIS Browser Mobile ${__APP_VERSION__}`;

/**
 * The shared export layer reads database rows, so the mobile catalog's view of a feature is
 * widened back into one.
 *
 * Every field the provenance block reads is real. The ones filled with null are the ones a
 * phone genuinely does not know -- harvest timings, feature counts, reconciliation state --
 * and a plausible-looking guess in a provenance block is worse than an absent value, since
 * the block exists to be trusted when a boundary is challenged after broadcast.
 */
function asSourceRow(feature: MobileFeature): SourceRow {
  const s = feature.source;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind as SourceRow['kind'],
    tier: 'A',
    endpoint: s.endpoint,
    layer_id: s.layerId,
    feature_type: feature.featureType,
    jurisdiction: feature.jurisdiction,
    vintage: s.vintage,
    licence: s.licence,
    attribution: s.attribution,
    name_fields: null,
    last_harvested_at: null,
    feature_count: null,
    status: 'ok',
    source_srid: s.srid,
    verified_count: null,
    verified_at: s.verifiedAt,
    notes: null,
    identity_field: s.identityField,
    archive_bytes: null,
    region: 'world',
  };
}

function asFeatureRow(feature: MobileFeature, indexedAt: string): FeatureRow {
  return {
    id: feature.id,
    source_id: feature.source.id,
    source_feature_id: feature.sourceFeatureId,
    official_name: feature.name,
    feature_type: feature.featureType,
    jurisdiction: feature.jurisdiction,
    // The desktop carries the source's own attributes through to the export. The mobile
    // index drops them -- they are the single largest thing in a catalog and most of them
    // are internal keys -- so this is an empty object rather than a partial one that would
    // read as "the source published only these".
    attributes_json: '{}',
    minx: feature.bbox?.[0] ?? null,
    miny: feature.bbox?.[1] ?? null,
    maxx: feature.bbox?.[2] ?? null,
    maxy: feature.bbox?.[3] ?? null,
    retrieved_at: indexedAt,
  };
}

function settingsFor(crs: string, precision: number): ExportSettings {
  return {
    // Never simplified here. See the note at the top of this file.
    simplificationRetentionPct: null,
    coordinatePrecision: precision,
    crs,
    generatedAt: new Date().toISOString(),
    generatedBy: GENERATED_BY,
  };
}

/** Local calendar date, for the filename. Never UTC -- the file is named for the artist's day. */
function localDate(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface ExportOptions {
  /** SVG only. One of shared/projections; ignored for GeoJSON, which is always 4326. */
  srid?: number;
  /** SVG only. */
  width?: number;
  height?: number;
}

export function buildExport(
  inputs: ExportInput[],
  format: ExportFormat,
  indexedAt: string,
  opts: ExportOptions = {},
): ExportedFile {
  if (inputs.length === 0) throw new Error('Nothing selected to export.');

  const sources = inputs.map((i) => asSourceRow(i.feature));
  const attribution = attributionLine(sources);
  const licences = licenceLines(sources);

  const filename = buildFilename({
    names: inputs.map((i) => i.feature.name),
    featureTypes: inputs.map((i) => i.feature.featureType),
    jurisdictions: inputs.map((i) => i.feature.jurisdiction),
    extension: format,
    date: localDate(),
  });

  if (format === 'geojson') {
    const result = buildGeoJson(
      inputs.map((i) => ({
        feature: asFeatureRow(i.feature, indexedAt),
        source: asSourceRow(i.feature),
        geometry: i.geometry,
        verticesBefore: i.vertexCount,
        sourceSrid: i.feature.source.srid,
        sourceGeneralisationDeg: i.generalisationDeg,
      })),
      settingsFor('EPSG:4326', DEFAULT_PRECISION),
      DEFAULT_PRECISION,
    );

    return {
      filename,
      text: result.text,
      mimeType: 'application/geo+json',
      bytes: new Blob([result.text]).size,
      warnings: result.warnings,
      attribution,
      licences,
    };
  }

  const srid = opts.srid ?? DEFAULT_SVG_SRID;
  const result = buildSvg(
    inputs.map((i) => ({ name: i.feature.name, geometry: i.geometry })),
    {
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      padding: DEFAULT_PADDING,
      srid,
      precision: DEFAULT_SVG_PRECISION,
      title: inputs.length === 1 ? inputs[0]!.feature.name : `${inputs.length} boundaries`,
      attribution,
      generatedBy: GENERATED_BY,
      generatedAt: new Date().toISOString(),
    },
  );

  return {
    filename,
    text: result.text,
    mimeType: 'image/svg+xml',
    bytes: new Blob([result.text]).size,
    warnings: result.warnings,
    attribution,
    licences,
  };
}

export type DeliveryMethod = 'shared' | 'downloaded';

/**
 * Gets the file off the phone.
 *
 * The share sheet is tried first, and that is not a nicety. An artist holding a phone wants
 * this boundary in AirDrop, in Slack, or in Files -- not sitting in a Downloads folder they
 * would then have to find. On iOS in particular a blob download opens the file in a tab
 * instead of saving it, so the anchor is the fallback, not the plan.
 *
 * `canShare` is checked with the actual file. Android Chrome advertises share and then
 * rejects unfamiliar MIME types, and finding that out from a thrown exception after the
 * user has tapped Export is worse than never offering it.
 */
export async function deliver(file: ExportedFile): Promise<DeliveryMethod> {
  const blob = new Blob([file.text], { type: file.mimeType });

  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    const payload = new File([blob], file.filename, { type: file.mimeType });
    if (navigator.canShare({ files: [payload] })) {
      try {
        await navigator.share({ files: [payload], title: file.filename });
        return 'shared';
      } catch (err) {
        // A cancelled share sheet is a decision, not a failure. Falling through to a
        // download would hand the artist a file they just declined.
        if (err instanceof Error && err.name === 'AbortError') return 'shared';
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next frame rather than immediately: Safari has not finished reading the
  // blob when click() returns, and revoking too early produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
