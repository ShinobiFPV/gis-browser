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
}

export interface HarvestProgress {
  sourceId: number;
  sourceName: string;
  phase: 'starting' | 'counting' | 'paging' | 'reconciling' | 'done' | 'failed';
  fetched: number;
  expected: number | null;
  message: string;
  /** Present when phase === 'failed'. Carries HTTP status and URL, never a bare message. */
  error?: string;
}

export interface AppSettings {
  /** Whether an Anthropic key is present. The key itself never leaves main. */
  hasAnthropicKey: boolean;
  dbPath: string;
  dataDir: string;
}
