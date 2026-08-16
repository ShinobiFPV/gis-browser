import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getDb } from '@db/index';
import { getFeatureWithSource } from '@db/geometry-cache';
import type { ExportProgress, ExportRequest, ExportResult } from '@shared/ipc';
import { DEFAULT_SVG_SRID, projectionFor } from '@shared/projections';
import type { FeatureRow, SourceRow } from '@shared/types';
import type { Geometry } from '../harvester/normalize/crs';
import { buildFilename, uniquePath } from '@export/filename';
import { buildGeoJson, DEFAULT_PRECISION, type GeoJsonFeatureInput } from '@export/geojson';
import { attributionLine, licenceLines, type ExportSettings } from '@export/provenance';
import { clampRetention, MAX_RETENTION, simplify, type SimplifyInput } from '@export/simplify';
import { buildSvg, DEFAULT_SVG_PRECISION } from '@export/svg';
import { getGeometry } from './geometry-service';
import { getSetting } from './settings';

/**
 * Export orchestration.
 *
 * The order matters and is not interchangeable:
 *
 *   1. fetch every selected geometry (cache first; a miss goes to the network)
 *   2. simplify ALL of them together, so shared borders stay shared
 *   3. rewind, round, and write
 *
 * Step 2 is why this cannot be a loop over single-feature exports. See export/simplify.ts.
 */

export type ProgressSink = (p: ExportProgress) => void;

/** Concurrency for the geometry fetch. Matches the harvester's per-host politeness. */
const FETCH_CONCURRENCY = 3;

interface Loaded {
  feature: FeatureRow;
  source: SourceRow;
  geometry: Geometry;
  vertexCount: number;
  sourceSrid: number | null;
  generalisationDeg: number | null;
}

/**
 * Local YYYY-MM-DD, formatted by hand.
 *
 * Deliberately not toLocaleDateString: this app has already lost a renderer to a corrupt
 * ICU data file, where any Intl call killed the process with no JS exception. Nothing in
 * the export path needs locale-aware formatting badly enough to reintroduce that.
 */
function localDate(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function version(): string {
  try {
    return app.getVersion();
  } catch {
    // Outside an Electron main process (tests), the app module is unavailable.
    return '0.0.0';
  }
}

/** Fetches geometry for every requested feature, in parallel but bounded. */
async function loadFeatures(featureIds: number[], onProgress?: ProgressSink): Promise<Loaded[]> {
  const db = getDb();
  const loaded = new Array<Loaded | undefined>(featureIds.length);
  let done = 0;

  const report = (message: string): void =>
    onProgress?.({ phase: 'fetching', done, total: featureIds.length, message });

  report('starting');

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= featureIds.length) return;
      const featureId = featureIds[index]!;

      const pair = getFeatureWithSource(db, featureId);
      if (!pair) {
        throw new Error(`Feature ${featureId} is not in the catalog, so it cannot be exported.`);
      }

      // Lazy fetch, coalesced and cached by geometry-service. A second export of the same
      // boundary costs nothing.
      const result = await getGeometry(featureId);
      const geometry = result.geometry as Geometry;
      if (!geometry || typeof geometry.type !== 'string') {
        throw new Error(
          `Feature ${featureId} ("${pair.feature.official_name}") returned no usable geometry.`,
        );
      }

      const cachedSrid = db
        .prepare('SELECT source_srid FROM geometries WHERE feature_id = ?')
        .get(featureId) as { source_srid: number | null } | undefined;

      loaded[index] = {
        feature: pair.feature,
        source: pair.source,
        geometry,
        vertexCount: result.vertexCount,
        sourceSrid: cachedSrid?.source_srid ?? pair.source.source_srid,
        generalisationDeg: result.generalisationDeg,
      };

      done++;
      report(pair.feature.official_name);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, featureIds.length) }, () => worker()),
  );

  return loaded.map((l, i) => {
    if (!l) throw new Error(`Geometry for feature ${featureIds[i]!} was never loaded`);
    return l;
  });
}

export async function runExport(req: ExportRequest, onProgress?: ProgressSink): Promise<ExportResult> {
  const started = Date.now();

  if (!Array.isArray(req.featureIds) || req.featureIds.length === 0) {
    throw new Error('Select at least one boundary before exporting.');
  }
  if (req.format !== 'geojson' && req.format !== 'svg') {
    throw new Error(`Unknown export format "${String(req.format)}"`);
  }

  const retention = clampRetention(req.retentionPct);
  const loaded = await loadFeatures(req.featureIds, onProgress);
  const warnings: string[] = [];

  // Source-side generalisation is disclosed every time. We did not choose it, cannot undo
  // it, and it is the one thing about an exported boundary most likely to be questioned.
  for (const l of loaded) {
    if (l.generalisationDeg !== null) {
      warnings.push(
        `"${l.feature.official_name}" was generalised by the source to about ` +
          `${(l.generalisationDeg * 111_000).toFixed(0)} m (${l.generalisationDeg}°) because the ` +
          `service could not return it at full resolution. That loss predates any simplification here.`,
      );
    }
  }

  /**
   * Mixed generalisation levels break topology in a way simplification cannot repair.
   *
   * Measured on real data: exporting Ontario, Quebec, Manitoba and Saskatchewan together,
   * Ontario and Quebec (both cached at 0.0005°) shared 484 border vertices, Manitoba and
   * Saskatchewan (both full resolution) shared 552 — but Ontario and Manitoba shared ZERO,
   * at every retention setting including 100%. mapshaper can only weld arcs that are
   * already coincident, and a generalised boundary no longer coincides with its
   * full-resolution neighbour. The seam between them will show a gap.
   *
   * This is a fact about what the services could serve us, not something to paper over.
   */
  const levels = new Set(loaded.map((l) => l.generalisationDeg));
  if (loaded.length > 1 && levels.size > 1) {
    const described = [...levels]
      .map((d) => (d === null ? 'full resolution' : `${d}°`))
      .sort()
      .join(' and ');
    warnings.push(
      `This export mixes boundaries retrieved at different resolutions (${described}). ` +
        `Borders between two boundaries at DIFFERENT resolutions cannot be kept aligned — ` +
        `their vertices never matched to begin with — so those seams may show a gap. ` +
        `Borders between boundaries at the same resolution are unaffected.`,
    );
  }

  onProgress?.({
    phase: 'simplifying',
    done: 0,
    total: loaded.length,
    message: retention >= MAX_RETENTION ? 'full resolution' : `${retention}% retention`,
  });

  const simplifyInputs: SimplifyInput[] = loaded.map((l, i) => ({
    // The index keeps keys unique when one export contains two features with the same name
    // from different sources, which is common for reserves.
    key: `${l.feature.official_name}#${i}`,
    geometry: l.geometry,
  }));

  const simplified = await simplify(simplifyInputs, retention);
  warnings.push(...simplified.warnings);

  const settings: ExportSettings = {
    simplificationRetentionPct: simplified.skipped ? null : retention,
    coordinatePrecision: req.format === 'svg' ? DEFAULT_SVG_PRECISION : DEFAULT_PRECISION,
    crs: req.format === 'svg' ? projectionFor(req.srid || DEFAULT_SVG_SRID).code : 'EPSG:4326',
    generatedAt: new Date().toISOString(),
    generatedBy: `GIS Browser ${version()}`,
  };

  const sources = loaded.map((l) => l.source);
  const attribution = attributionLine(sources);
  const licences = licenceLines(sources);

  let text: string;
  if (req.format === 'geojson') {
    const inputs: GeoJsonFeatureInput[] = loaded.map((l, i) => ({
      feature: l.feature,
      source: l.source,
      geometry: simplified.features[i]!.geometry,
      verticesBefore: l.vertexCount,
      sourceSrid: l.sourceSrid,
      sourceGeneralisationDeg: l.generalisationDeg,
    }));
    const built = buildGeoJson(inputs, settings, DEFAULT_PRECISION);
    warnings.push(...built.warnings);
    text = built.text;
  } else {
    const built = buildSvg(
      loaded.map((l, i) => ({
        name: l.feature.official_name,
        geometry: simplified.features[i]!.geometry,
      })),
      {
        width: req.width > 0 ? req.width : 1920,
        height: req.height > 0 ? req.height : 1080,
        padding: req.padding >= 0 ? req.padding : 40,
        srid: req.srid || DEFAULT_SVG_SRID,
        precision: DEFAULT_SVG_PRECISION,
        title:
          loaded.length === 1
            ? loaded[0]!.feature.official_name
            : `${loaded.length} boundaries`,
        attribution,
        generatedBy: settings.generatedBy,
        generatedAt: settings.generatedAt,
      },
    );
    warnings.push(...built.warnings);
    text = built.text;
  }

  const bytes = Buffer.byteLength(text, 'utf8');

  const result: ExportResult = {
    path: null,
    format: req.format,
    featureCount: loaded.length,
    verticesBefore: simplified.verticesBefore,
    verticesAfter: simplified.verticesAfter,
    bytes,
    attribution,
    licences,
    warnings,
    elapsedMs: Date.now() - started,
  };

  if (req.previewOnly) {
    onProgress?.({ phase: 'done', done: loaded.length, total: loaded.length, message: 'preview' });
    return result;
  }

  onProgress?.({ phase: 'writing', done: loaded.length, total: loaded.length, message: 'writing file' });

  const folder = getSetting('exportFolder');
  mkdirSync(folder, { recursive: true });

  const filename = buildFilename({
    names: loaded.map((l) => l.feature.official_name),
    featureTypes: loaded.map((l) => l.feature.feature_type),
    jurisdictions: loaded.map((l) => l.feature.jurisdiction),
    extension: req.format,
    // Local date, not UTC: a file exported at 8pm Toronto time should not be dated tomorrow.
    date: localDate(),
  });

  const path = uniquePath(folder, filename, existsSync, join);
  writeFileSync(path, text, 'utf8');

  console.log(
    `[export] ${req.format} ${loaded.length} feature(s) ` +
      `${simplified.verticesBefore}->${simplified.verticesAfter} vertices ` +
      `${bytes} bytes in ${Date.now() - started}ms -> ${path}`,
  );

  onProgress?.({ phase: 'done', done: loaded.length, total: loaded.length, message: path });

  return { ...result, path, elapsedMs: Date.now() - started };
}
