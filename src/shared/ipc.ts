import type { AppSettings, Candidate, HarvestProgress, SourceRow } from './types';

/**
 * The full renderer <-> main surface. The preload bridge exposes exactly these and
 * nothing else -- no ipcRenderer, no Node, no fs. Adding a channel means adding it here,
 * in preload.ts, and in main/ipc.ts, so the three stay in lockstep.
 */
export const CH = {
  // invoke/handle
  settingsGet: 'settings:get',
  keySet: 'key:set',
  keyClear: 'key:clear',
  modelSet: 'model:set',
  sourcesList: 'sources:list',
  sourcesSetStatus: 'sources:setStatus',
  downloadsList: 'downloads:list',
  downloadsRemove: 'downloads:remove',
  harvestStart: 'harvest:start',
  harvestCancel: 'harvest:cancel',
  searchRun: 'search:run',
  geometryGet: 'geometry:get',
  exportRun: 'export:run',
  exportPreview: 'export:preview',
  exportReveal: 'export:reveal',
  exportSetFolder: 'export:setFolder',

  // main -> renderer events
  harvestProgress: 'harvest:progress',
  exportProgress: 'export:progress',
  log: 'app:log',
} as const;

export interface SearchRequest {
  prompt: string;
  featureTypeFilter?: string | null;
  jurisdictionFilter?: string | null;
  /** M3 acceptance runs with this false: local FTS + fuzzy only, no Claude. */
  useLlm: boolean;
  limit?: number;
}

export interface SearchResponse {
  candidates: Candidate[];
  /** What the parser understood, shown in the UI so a bad parse is visible. */
  parsed: {
    placeNames: string[];
    featureTypeHint: string | null;
    jurisdictionHint: string | null;
    vintageHint: string | null;
    wants: string;
    notes: string;
    /** 'llm' when Claude parsed it, 'keyword' when the fallback did. */
    via: 'llm' | 'keyword';
  };
  timings: { parseMs: number; matchMs: number; rankMs: number };
}

/** What `geometry:get` hands back. Geometry is EPSG:4326 GeoJSON. */
export interface GeometryResult {
  geometry: unknown;
  vertexCount: number;
  bbox: [number, number, number, number] | null;
  /** False means this request went to the network and warmed the cache. */
  fromCache: boolean;
  fetchMs: number;
  /** Parts the service returned before merging; >1 means a multipart boundary. */
  partCount: number;
  attribution: string | null;
  /**
   * Degrees of generalisation the SOURCE applied, when full resolution could not be
   * served. null means full resolution. Distinct from the export simplification slider --
   * this is a provenance fact about what we were able to retrieve.
   */
  generalisationDeg: number | null;
}

/** A Tier B archive sitting on disk. */
export interface BulkDownload {
  sourceId: number;
  sourceName: string;
  url: string;
  localPath: string;
  bytes: number | null;
  sha256: string | null;
  downloadedAt: string;
  /** False when the row is in the catalog but the file has since been deleted. */
  present: boolean;
}

export type ExportFormat = 'geojson' | 'svg';

export interface ExportRequest {
  /** Catalog feature ids, in the order they should appear in the file. */
  featureIds: number[];
  format: ExportFormat;
  /** 1..100. 100 means no simplification at all. */
  retentionPct: number;
  /** SVG only. EPSG code from shared/projections. */
  srid: number;
  /** SVG only, in pixels. */
  width: number;
  height: number;
  padding: number;
  /**
   * Compute vertex counts and warnings without writing a file. Backs the live before/after
   * readout, which has to run real simplification -- a linear estimate is wrong, because
   * topology-preserving Visvalingam does not hit the requested percentage exactly.
   */
  previewOnly?: boolean;
}

export interface ExportResult {
  /** Absolute path written, or null for a preview. */
  path: string | null;
  format: ExportFormat;
  featureCount: number;
  verticesBefore: number;
  verticesAfter: number;
  bytes: number;
  /** Ready to paste into a lower third. Joined when an export mixes sources. */
  attribution: string;
  /** Every distinct licence in the export, so a mixed-licence set is visible. */
  licences: string[];
  /** Lost holes, unclosed rings, source-side generalisation -- never silent. */
  warnings: string[];
  elapsedMs: number;
}

export interface ExportProgress {
  phase: 'fetching' | 'simplifying' | 'writing' | 'done' | 'failed';
  done: number;
  total: number;
  message: string;
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  at: string;
}

/** Shape the preload bridge puts on `window.gis`. */
export interface GisBridge {
  settingsGet(): Promise<AppSettings>;
  keySet(key: string): Promise<{ ok: boolean; error?: string }>;
  keyClear(): Promise<{ ok: boolean }>;
  modelSet(id: string): Promise<{ ok: boolean; error?: string }>;
  sourcesList(): Promise<SourceRow[]>;
  sourcesSetStatus(id: number, status: SourceRow['status']): Promise<void>;
  downloadsList(): Promise<BulkDownload[]>;
  downloadsRemove(sourceId: number): Promise<{ ok: boolean; freedBytes: number }>;
  harvestStart(sourceIds: number[]): Promise<{ ok: boolean; error?: string }>;
  harvestCancel(): Promise<void>;
  searchRun(req: SearchRequest): Promise<SearchResponse>;
  geometryGet(featureId: number): Promise<GeometryResult>;
  exportRun(req: ExportRequest): Promise<ExportResult>;
  exportPreview(req: ExportRequest): Promise<ExportResult>;
  exportReveal(path: string): Promise<void>;
  exportSetFolder(): Promise<{ ok: boolean; folder?: string }>;
  onHarvestProgress(cb: (p: HarvestProgress) => void): () => void;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  onLog(cb: (l: LogLine) => void): () => void;
}
