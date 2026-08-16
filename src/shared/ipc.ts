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
  harvestStart: 'harvest:start',
  harvestCancel: 'harvest:cancel',
  searchRun: 'search:run',
  geometryGet: 'geometry:get',
  exportRun: 'export:run',

  // main -> renderer events
  harvestProgress: 'harvest:progress',
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
  harvestStart(sourceIds: number[]): Promise<{ ok: boolean; error?: string }>;
  harvestCancel(): Promise<void>;
  searchRun(req: SearchRequest): Promise<SearchResponse>;
  geometryGet(featureId: number): Promise<GeometryResult>;
  onHarvestProgress(cb: (p: HarvestProgress) => void): () => void;
  onLog(cb: (l: LogLine) => void): () => void;
}
