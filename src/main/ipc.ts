import { ipcMain, type BrowserWindow } from 'electron';
import { CH, type SearchRequest, type SearchResponse } from '@shared/ipc';
import type { AppSettings, SourceRow } from '@shared/types';
import { getDb } from '@db/index';
import { listSources, setSourceStatus } from '@db/queries';
import { clearKey, hasKey, setKey } from './keychain';
import { cancelHarvest, startHarvest } from './harvester-host';
import { getGeometry } from './geometry-service';
import { runSearch } from './search-service';
import { MODELS } from './anthropic';
import { getSetting, setSetting } from './settings';

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
    anthropicModel: getSetting('anthropicModel'),
    models: MODELS,
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
    if (!req || typeof req.prompt !== 'string') throw new Error('search:run expects a prompt string');
    return runSearch(req);
  });

  ipcMain.handle(CH.modelSet, (_e, id: unknown) => {
    if (typeof id !== 'string' || !MODELS.some((m) => m.id === id)) {
      return { ok: false, error: 'Unknown model' };
    }
    setSetting('anthropicModel', id);
    return { ok: true };
  });

  // Lazy fetch on a cache miss, then cached permanently. The renderer shows a loading
  // state for the duration -- a first fetch of a big boundary is a real wait.
  ipcMain.handle(CH.geometryGet, async (_e, featureId: unknown) => {
    if (typeof featureId !== 'number') throw new Error('geometry:get expects a numeric feature id');
    return getGeometry(featureId);
  });

  ipcMain.handle(CH.exportRun, () => {
    throw new Error('export is not implemented until M5');
  });
}
