import { contextBridge, ipcRenderer } from 'electron';
import { CH, type GisBridge, type LogLine, type SearchRequest } from '@shared/ipc';
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
  sourcesList: () => ipcRenderer.invoke(CH.sourcesList),
  sourcesSetStatus: (id: number, status: SourceRow['status']) => ipcRenderer.invoke(CH.sourcesSetStatus, id, status),
  harvestStart: (sourceIds: number[]) => ipcRenderer.invoke(CH.harvestStart, sourceIds),
  harvestCancel: () => ipcRenderer.invoke(CH.harvestCancel),
  searchRun: (req: SearchRequest) => ipcRenderer.invoke(CH.searchRun, req),
  geometryGet: (featureId: number) => ipcRenderer.invoke(CH.geometryGet, featureId),

  onHarvestProgress: (cb: (p: HarvestProgress) => void) => {
    const handler = (_e: unknown, p: HarvestProgress) => cb(p);
    ipcRenderer.on(CH.harvestProgress, handler);
    return () => ipcRenderer.removeListener(CH.harvestProgress, handler);
  },

  onLog: (cb: (l: LogLine) => void) => {
    const handler = (_e: unknown, l: LogLine) => cb(l);
    ipcRenderer.on(CH.log, handler);
    return () => ipcRenderer.removeListener(CH.log, handler);
  },
};

contextBridge.exposeInMainWorld('gis', bridge);
