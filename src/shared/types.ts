import type { FeatureType, Jurisdiction } from './taxonomy';

/** How a source is talked to. Drives which catalog client handles it. */
export type SourceKind = 'arcgis-hub' | 'esri-rest' | 'wfs' | 'ckan' | 'bulk-file';

/**
 * Tier A -- queryable per feature. Index attributes only; fetch geometry lazily.
 * Tier B -- bulk file only. Geometry arrives with the download, user-triggered.
 */
export type SourceTier = 'A' | 'B';

export type SourceStatus =
  | 'seeded' // in the registry, never harvested
  | 'harvesting'
  | 'ok'
  | 'stale'
  | 'failed'
  | 'disabled';

export interface SourceRow {
  id: number;
  name: string;
  kind: SourceKind;
  tier: SourceTier;
  endpoint: string;
  layer_id: string | null;
  feature_type: FeatureType;
  jurisdiction: Jurisdiction | null;
  vintage: string | null;
  licence: string | null;
  attribution: string | null;
  /** JSON array of attribute names holding names/aliases, most authoritative first. */
  name_fields: string | null;
  last_harvested_at: string | null;
  feature_count: number | null;
  status: SourceStatus;

  /** Verification metadata carried over from the seed registry. */
  source_srid: number | null;
  verified_count: number | null;
  verified_at: string | null;
  notes: string | null;

  /**
   * Attribute identifying the real-world feature on multipart layers. When set, ingest
   * keys on it instead of the native object id and merges the parts.
   */
  identity_field: string | null;

  /**
   * Tier B only: download size in bytes, measured at verification. NULL for Tier A, which
   * pages a service rather than downloading a file. Shown before the download starts so
   * "explicit user-triggered" means an informed trigger.
   */
  archive_bytes: number | null;

  /** Computed by listSources(): rows actually indexed so far. */
  indexed_count?: number;
}

/** The registry entry as authored in the seed file, before it gets an id. */
export interface SeedSource {
  name: string;
  kind: SourceKind;
  tier: SourceTier;
  endpoint: string;
  layerId: string | null;
  featureType: FeatureType;
  jurisdiction: Jurisdiction | null;
  vintage: string | null;
  licence: string;
  attribution: string;
  nameFields: string[];
  /** Native SRID the service publishes in, recorded so reprojection is explicit. */
  sourceSrid: number | null;
  /** Feature count observed during endpoint verification, for harvest reconciliation. */
  verifiedCount: number | null;
  /** ISO date the endpoint was last confirmed live. */
  verifiedAt: string | null;
  /** Set on multipart layers so ingest merges polygons belonging to one feature. */
  identityField?: string;
  /** Tier B only: measured download size in bytes, so the UI can state the cost. */
  archiveBytes?: number;
  notes?: string;
}

export interface FeatureRow {
  id: number;
  source_id: number;
  source_feature_id: string;
  official_name: string;
  feature_type: FeatureType;
  jurisdiction: string | null;
  attributes_json: string;
  minx: number | null;
  miny: number | null;
  maxx: number | null;
  maxy: number | null;
  retrieved_at: string;
}

export interface GeometryRow {
  feature_id: number;
  geometry_json: string;
  vertex_count: number | null;
  source_srid: number | null;
  content_hash: string | null;
  cached_at: string;
}

export type AliasKind = 'official' | 'french' | 'attribute' | 'stripped' | 'manual';

export interface AliasRow {
  id: number;
  feature_id: number;
  alias: string;
  alias_kind: AliasKind | null;
}

/** A search hit as shown in the candidate list. Never carries geometry. */
export interface Candidate {
  featureId: number;
  officialName: string;
  featureType: FeatureType;
  jurisdiction: string | null;
  sourceId: number;
  sourceName: string;
  vintage: string | null;
  attribution: string | null;
  bbox: [number, number, number, number] | null;
  hasCachedGeometry: boolean;
  /** 0..1 from the local matcher. The LLM ranker adds its own score alongside. */
  matchScore: number;
  matchedAlias: string | null;
  /** Which pass found it, so a fuzzy rescue is distinguishable from an exact hit. */
  matchedVia?: 'fts-all' | 'fts-any' | 'fuzzy';
  /** One line explaining the ranking, shown in the UI. */
  justification?: string;
  /** True when Claude scored this candidate rather than the local ranker alone. */
  rankedByLlm?: boolean;
}

export interface HarvestProgress {
  sourceId: number;
  sourceName: string;
  /** 'downloading' and 'extracting' are Tier B only; 'paging' covers reading its records. */
  phase:
    | 'starting'
    | 'counting'
    | 'downloading'
    | 'extracting'
    | 'paging'
    | 'reconciling'
    | 'done'
    | 'failed';
  fetched: number;
  expected: number | null;
  message: string;
  /** Present when phase === 'failed'. Carries HTTP status and URL, never a bare message. */
  error?: string;
}

/** Capability summary for a selectable Claude model. Mirrors main/anthropic.ts. */
export interface ModelChoice {
  id: string;
  label: string;
  structuredOutputs: boolean;
  effort: boolean;
  adaptiveThinking: boolean;
  note?: string;
}

export interface AppSettings {
  /** Whether an Anthropic key is present. The key itself never leaves main. */
  hasAnthropicKey: boolean;
  dbPath: string;
  dataDir: string;
  anthropicModel: string;
  models: ModelChoice[];
  /** Where exports are written. Changed in Settings, never asked for mid-export. */
  exportFolder: string;
}
