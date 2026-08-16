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
  sourcesList(): Promise<SourceRow[]>;
  sourcesSetStatus(id: number, status: SourceRow['status']): Promise<void>;
  harvestStart(sourceIds: number[]): Promise<{ ok: boolean; error?: string }>;
  harvestCancel(): Promise<void>;
  searchRun(req: SearchRequest): Promise<SearchResponse>;
  geometryGet(featureId: number): Promise<{ geometry: unknown; vertexCount: number } | null>;
  onHarvestProgress(cb: (p: HarvestProgress) => void): () => void;
  onLog(cb: (l: LogLine) => void): () => void;
}
