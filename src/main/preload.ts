import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  type ExportProgress,
  type ExportRequest,
  type GisBridge,
  type LogLine,
  type SearchRequest,
} from '@shared/ipc';
import type { HarvestProgress, SourceRow } from '@shared/types';

/**
 * The entire renderer-facing API. contextIsolation is on and nodeIntegration is off, so
 * this object is the only thing the UI can reach. No ipcRenderer passthrough, no fs,
 * no arbitrary channel names.
 */
const bridge: GisBridge = {
  settingsGet: () => ipcRenderer.invoke(CH.settingsGet),
  keySet: (key: string) => ipcRenderer.invoke(CH.keySet, key),
  keyClear: () => ipcRenderer.invoke(CH.keyClear),
  modelSet: (id: string) => ipcRenderer.invoke(CH.modelSet, id),
  sourcesList: () => ipcRenderer.invoke(CH.sourcesList),
  sourcesSetStatus: (id: number, status: SourceRow['status']) => ipcRenderer.invoke(CH.sourcesSetStatus, id, status),
  harvestStart: (sourceIds: number[]) => ipcRenderer.invoke(CH.harvestStart, sourceIds),
  harvestCancel: () => ipcRenderer.invoke(CH.harvestCancel),
  searchRun: (req: SearchRequest) => ipcRenderer.invoke(CH.searchRun, req),
  geometryGet: (featureId: number) => ipcRenderer.invoke(CH.geometryGet, featureId),
  exportRun: (req: ExportRequest) => ipcRenderer.invoke(CH.exportRun, req),
  exportPreview: (req: ExportRequest) => ipcRenderer.invoke(CH.exportPreview, req),
  exportReveal: (path: string) => ipcRenderer.invoke(CH.exportReveal, path),
  exportSetFolder: () => ipcRenderer.invoke(CH.exportSetFolder),

  onHarvestProgress: (cb: (p: HarvestProgress) => void) => {
    const handler = (_e: unknown, p: HarvestProgress) => cb(p);
    ipcRenderer.on(CH.harvestProgress, handler);
    return () => ipcRenderer.removeListener(CH.harvestProgress, handler);
  },

  onExportProgress: (cb: (p: ExportProgress) => void) => {
    const handler = (_e: unknown, p: ExportProgress) => cb(p);
    ipcRenderer.on(CH.exportProgress, handler);
    return () => ipcRenderer.removeListener(CH.exportProgress, handler);
  },

  onLog: (cb: (l: LogLine) => void) => {
    const handler = (_e: unknown, l: LogLine) => cb(l);
    ipcRenderer.on(CH.log, handler);
    return () => ipcRenderer.removeListener(CH.log, handler);
  },
};

contextBridge.exposeInMainWorld('gis', bridge);
