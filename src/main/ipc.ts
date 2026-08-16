import { ipcMain, type BrowserWindow } from 'electron';
import { CH, type SearchRequest, type SearchResponse } from '@shared/ipc';
import type { AppSettings, SourceRow } from '@shared/types';
import { getDb } from '@db/index';
import { getCachedGeometry, listSources, setSourceStatus } from '@db/queries';
import { clearKey, hasKey, setKey } from './keychain';
import { cancelHarvest, startHarvest } from './harvester-host';

/**
 * Every channel in shared/ipc.ts is registered here exactly once. Handlers stay thin:
 * they validate, call into db/ or resolve/, and return plain data. No geometry crosses
 * this boundary except through geometryGet.
 */
export function registerIpc(win: BrowserWindow, ctx: { dbPath: string; dataDir: string }): void {
  ipcMain.handle(CH.settingsGet, (): AppSettings => ({
    hasAnthropicKey: hasKey(),
    dbPath: ctx.dbPath,
    dataDir: ctx.dataDir,
  }));

  ipcMain.handle(CH.keySet, (_e, key: unknown) => {
    if (typeof key !== 'string') return { ok: false, error: 'Key must be a string' };
    return setKey(key);
  });

  ipcMain.handle(CH.keyClear, () => {
    clearKey();
    return { ok: true };
  });

  ipcMain.handle(CH.sourcesList, (): SourceRow[] => listSources(getDb()));

  ipcMain.handle(CH.sourcesSetStatus, (_e, id: unknown, status: unknown) => {
    if (typeof id !== 'number') throw new Error('sources:setStatus expects a numeric id');
    setSourceStatus(getDb(), id, status as SourceRow['status']);
  });

  ipcMain.handle(CH.harvestStart, (_e, sourceIds: unknown) => {
    if (!Array.isArray(sourceIds) || sourceIds.some((n) => typeof n !== 'number')) {
      return { ok: false, error: 'harvest:start expects an array of numeric source ids' };
    }
    return startHarvest(win, ctx.dbPath, sourceIds as number[]);
  });

  ipcMain.handle(CH.harvestCancel, () => {
    cancelHarvest();
  });

  ipcMain.handle(CH.searchRun, async (_e, req: SearchRequest): Promise<SearchResponse> => {
    // M3 wires the local matcher here; M4 adds the Claude parse and rank passes.
    void req;
    throw new Error('search is not implemented until M3');
  });

  ipcMain.handle(CH.geometryGet, (_e, featureId: unknown) => {
    if (typeof featureId !== 'number') throw new Error('geometry:get expects a numeric feature id');
    const row = getCachedGeometry(getDb(), featureId);
    if (!row) return null; // M2 turns a cache miss into a lazy fetch.
    return { geometry: JSON.parse(row.geometry_json), vertexCount: row.vertex_count ?? 0 };
  });

  ipcMain.handle(CH.exportRun, () => {
    throw new Error('export is not implemented until M5');
  });
}
