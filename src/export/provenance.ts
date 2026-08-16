import type { FeatureRow, SourceRow } from '@shared/types';

/**
 * The `_provenance` block.
 *
 * The brief's reasoning: provenance matters when a boundary goes to air. If a riding
 * outline is challenged after broadcast, this block is the answer — which service it came
 * from, under what licence, from which vintage, on what date, and what we did to it
 * afterwards. `attributes_json` is never discarded for the same reason.
 *
 * It is written onto every feature rather than once per file, so that a feature dragged
 * out of a collection into another document carries its own history with it. That is a
 * deliberate redundancy.
 */

export interface ExportSettings {
  /** null when no simplification was applied. */
  simplificationRetentionPct: number | null;
  coordinatePrecision: number;
  /** EPSG code the coordinates are in. Always 4326 for GeoJSON. */
  crs: string;
  generatedAt: string;
  generatedBy: string;
}

export interface FeatureVertexCounts {
  before: number;
  after: number;
}

/**
 * ExportSettings serialised for the file.
 *
 * Written out explicitly rather than spread, for two reasons. Every other key we emit is
 * snake_case, and a half-camelCase provenance block looks like two people wrote it. More
 * importantly, `crs` is a reserved word in GeoJSON 2008 — a member of that name, at any
 * depth, invites a reader or a linter to interpret it as a coordinate-system override.
 * RFC 7946 removed it, so ours is called something that cannot be mistaken for it.
 */
export interface SerialisedExportSettings {
  generated_at: string;
  generated_by: string;
  coordinate_reference_system: string;
  coordinate_precision: number;
  simplification_retention_pct: number | null;
}

export function serialiseSettings(s: ExportSettings): SerialisedExportSettings {
  return {
    generated_at: s.generatedAt,
    generated_by: s.generatedBy,
    coordinate_reference_system: s.crs,
    coordinate_precision: s.coordinatePrecision,
    simplification_retention_pct: s.simplificationRetentionPct,
  };
}

export interface Provenance {
  official_name: string;
  feature_type: string;
  jurisdiction: string | null;
  source: {
    name: string;
    url: string;
    layer: string | null;
    kind: string;
    tier: string;
    licence: string | null;
    attribution: string | null;
    vintage: string | null;
    /** When the endpoint was last confirmed live during registry verification. */
    endpoint_verified_at: string | null;
  };
  source_feature_id: string;
  source_srid: number | null;
  indexed_at: string;
  /**
   * Degrees of generalisation the SOURCE applied because it could not serve the boundary
   * at full resolution. Distinct from our own simplification below, and far more important
   * to disclose: we did not choose it and cannot undo it.
   */
  source_generalisation_deg: number | null;
  export: SerialisedExportSettings & {
    vertices_before: number;
    vertices_after: number;
    simplification_method: string | null;
    topology_preserving: boolean | null;
  };
}

export function buildProvenance(
  feature: FeatureRow,
  source: SourceRow,
  vertices: FeatureVertexCounts,
  settings: ExportSettings,
  sourceGeneralisationDeg: number | null,
  sourceSrid: number | null,
): Provenance {
  const simplified = settings.simplificationRetentionPct !== null;

  return {
    official_name: feature.official_name,
    feature_type: feature.feature_type,
    jurisdiction: feature.jurisdiction,
    source: {
      name: source.name,
      url: source.endpoint,
      layer: source.layer_id === '' ? null : source.layer_id,
      kind: source.kind,
      tier: source.tier,
      licence: source.licence,
      attribution: source.attribution,
      vintage: source.vintage,
      endpoint_verified_at: source.verified_at,
    },
    source_feature_id: feature.source_feature_id,
    source_srid: sourceSrid,
    indexed_at: feature.retrieved_at,
    source_generalisation_deg: sourceGeneralisationDeg,
    export: {
      ...serialiseSettings(settings),
      vertices_before: vertices.before,
      vertices_after: vertices.after,
      simplification_method: simplified ? 'visvalingam' : null,
      topology_preserving: simplified ? true : null,
    },
  };
}

/**
 * The credit line, ready to paste into a lower third.
 *
 * Distinct sources are joined rather than deduplicated by licence, because a multi-feature
 * export can legitimately mix NRCan reserve boundaries with StatCan census subdivisions and
 * both must be credited.
 */
export function attributionLine(sources: SourceRow[]): string {
  const credits = [...new Set(sources.map((s) => s.attribution).filter((a): a is string => !!a))];
  return credits.join('; ');
}

/** Every distinct licence in an export, so a mixed-licence set is obvious before it airs. */
export function licenceLines(sources: SourceRow[]): string[] {
  return [...new Set(sources.map((s) => s.licence).filter((l): l is string => !!l))];
}
