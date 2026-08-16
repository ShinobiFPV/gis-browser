import mapshaper from 'mapshaper';
import { countVertices, type Geometry } from '../harvester/normalize/crs';
import { countParts, droppedAreas, formatArea, holeAreasHa, partAreasHa } from './winding';

/**
 * Topology-preserving simplification, via mapshaper's Visvalingam implementation.
 *
 * Why topology matters here, concretely. Every feature in one export is handed to
 * mapshaper as a single dataset so it can build a shared-arc topology first. Two ridings
 * that share a border then share the SAME simplified arc, and the border stays a border.
 * Simplifying them one at a time instead makes each side discard different vertices, and
 * a hairline of background shows through the seam — on a broadcast map, at the exact
 * moment the wipe lands on it.
 *
 * Measured on a synthetic pair sharing a 201-vertex edge at 5% retention: simplified
 * together, 0 of the shared vertices diverge; simplified separately, 40 do.
 *
 * `keep-shapes` is not optional. Without it Visvalingam removes whole small polygons once
 * their area falls below the threshold — a 400-vertex 0.0005° reserve vanished outright
 * at 1% retention in testing, while the large polygon beside it survived. Losing a reserve
 * because it is small is precisely the failure this app exists to prevent.
 */

export interface SimplifyInput {
  /** Stable identifier used to line results back up. */
  key: string;
  geometry: Geometry;
}

export interface SimplifyOutput {
  key: string;
  geometry: Geometry;
}

export interface SimplifyResult {
  features: SimplifyOutput[];
  verticesBefore: number;
  verticesAfter: number;
  /** True when the request was a no-op and geometry was passed through untouched. */
  skipped: boolean;
  warnings: string[];
  elapsedMs: number;
}

/** mapshaper rejects 0% and anything above 100%. */
export const MIN_RETENTION = 1;
export const MAX_RETENTION = 100;

export function clampRetention(pct: number): number {
  if (!Number.isFinite(pct)) return MAX_RETENTION;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, Math.round(pct)));
}

interface MapshaperFeature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: Geometry | null;
}

interface MapshaperCollection {
  type: string;
  features?: MapshaperFeature[];
  geometries?: Geometry[];
}

function applyCommands(command: string, input: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    mapshaper.applyCommands(command, input, (err: Error | null, output: Record<string, unknown>) => {
      if (err) rejectPromise(err);
      else resolvePromise(output);
    });
  });
}

/**
 * Summarises dropped shapes without listing them all.
 *
 * Quebec is 21,492 separate polygons — the mainland plus every islet in Hudson Bay and
 * every island in every lake. At 5% retention over 21,000 of them go, and naming each one
 * produced half a megabyte of warning text. Only the largest matter: if the biggest thing
 * lost is sub-pixel at the canvas size, nothing below it can be visible either.
 */
function describeLost(areasDescending: number[]): string {
  if (areasDescending.length === 0) return '';
  const shown = areasDescending.slice(0, 3).map(formatArea).join(', ');
  const total = areasDescending.reduce((a, b) => a + b, 0);
  if (areasDescending.length <= 3) return `Dropped: ${shown}.`;
  return `Largest dropped: ${shown} (${areasDescending.length} in total, ${formatArea(total)} combined).`;
}

export async function simplify(inputs: SimplifyInput[], retentionPct: number): Promise<SimplifyResult> {
  const started = Date.now();
  const verticesBefore = inputs.reduce((n, f) => n + countVertices(f.geometry), 0);
  const retention = clampRetention(retentionPct);

  if (inputs.length === 0) {
    return { features: [], verticesBefore: 0, verticesAfter: 0, skipped: true, warnings: [], elapsedMs: 0 };
  }

  // At full retention there is nothing to do, and running the geometry through mapshaper
  // anyway would rebuild topology and rewrite coordinates for no benefit.
  if (retention >= MAX_RETENTION) {
    return {
      features: inputs.map((f) => ({ key: f.key, geometry: f.geometry })),
      verticesBefore,
      verticesAfter: verticesBefore,
      skipped: true,
      warnings: [],
      elapsedMs: Date.now() - started,
    };
  }

  // The index property is load-bearing twice over: it lines results back up with their
  // provenance, and it guarantees a non-empty attribute table. mapshaper emits a bare
  // GeometryCollection instead of a FeatureCollection when every feature's properties are
  // empty, which would strip the mapping entirely.
  const collection = {
    type: 'FeatureCollection',
    features: inputs.map((f, i) => ({
      type: 'Feature',
      properties: { __i: i },
      geometry: f.geometry,
    })),
  };

  const command =
    `-i in.json -simplify visvalingam ${retention}% keep-shapes -o out.json format=geojson`;

  let output: Record<string, unknown>;
  try {
    output = await applyCommands(command, { 'in.json': JSON.stringify(collection) });
  } catch (err) {
    throw new Error(
      `Simplification failed at ${retention}% retention for ${inputs.length} feature(s): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const raw = output['out.json'];
  if (raw === undefined) {
    throw new Error(`mapshaper produced no output file. Command was: ${command}`);
  }

  const parsed = JSON.parse(Buffer.from(raw as Uint8Array).toString('utf8')) as MapshaperCollection;

  if (!Array.isArray(parsed.features)) {
    throw new Error(
      `mapshaper returned a ${parsed.type} rather than a FeatureCollection, so simplified ` +
        `geometry cannot be matched back to its provenance.`,
    );
  }

  if (parsed.features.length !== inputs.length) {
    throw new Error(
      `Simplification returned ${parsed.features.length} features for ${inputs.length} inputs. ` +
        `keep-shapes should make that impossible; refusing to export a set that lost a boundary.`,
    );
  }

  const warnings: string[] = [];
  const features: SimplifyOutput[] = [];

  for (const [position, feature] of parsed.features.entries()) {
    const index = feature.properties?.['__i'];
    if (typeof index !== 'number' || index < 0 || index >= inputs.length) {
      throw new Error(
        `Simplified feature at position ${position} lost its index property, so it cannot be ` +
          `matched back to a catalog feature.`,
      );
    }
    const source = inputs[index]!;

    if (!feature.geometry) {
      throw new Error(
        `Simplification reduced "${source.key}" to null geometry at ${retention}% retention. ` +
          `mapshaper does this to geometry it considers invalid — most often a self-intersecting ` +
          `ring in the source data. Export the feature at 100% to inspect it.`,
      );
    }

    // What was lost matters far less than how big it was. On a real multipart reserve at
    // 5% retention the dropped part was a 0.3 ha islet out of 7,502 ha -- sub-pixel on any
    // broadcast canvas, and not worth raising the slider for. The same warning without a
    // size would have sent someone hunting for a problem that did not exist.
    const name = source.key.replace(/#\d+$/, '');

    const partsBefore = countParts(source.geometry);
    const partsAfter = countParts(feature.geometry);
    if (partsAfter < partsBefore) {
      const lost = droppedAreas(partAreasHa(source.geometry), partAreasHa(feature.geometry));
      const total = partAreasHa(source.geometry).reduce((a, b) => a + b, 0);
      const n = partsBefore - partsAfter;
      warnings.push(
        `"${name}" lost ${n === 1 ? '1 of' : `${n} of`} ${partsBefore} separate ` +
          `${n === 1 ? 'part' : 'parts'} at ${retention}% retention. ${describeLost(lost)} ` +
          `Total boundary area is ${formatArea(total)}. Raise the slider to keep ` +
          `${n === 1 ? 'it' : 'them'}.`,
      );
    }

    // Holes counted on their own, so the number in the message and the areas listed after
    // it describe the same set of shapes.
    const holesBefore = holeAreasHa(source.geometry);
    const holesAfter = holeAreasHa(feature.geometry);
    if (holesAfter.length < holesBefore.length) {
      const lost = droppedAreas(holesBefore, holesAfter);
      warnings.push(
        `"${name}" lost ${lost.length} of ${holesBefore.length} ` +
          `${holesBefore.length === 1 ? 'enclave or hole' : 'enclaves or holes'} at ` +
          `${retention}% retention. ${describeLost(lost)} Raise the slider to keep ` +
          `${lost.length === 1 ? 'it' : 'them'}.`,
      );
    }

    features.push({ key: source.key, geometry: feature.geometry });
  }

  return {
    features,
    verticesBefore,
    verticesAfter: features.reduce((n, f) => n + countVertices(f.geometry), 0),
    skipped: false,
    warnings,
    elapsedMs: Date.now() - started,
  };
}
