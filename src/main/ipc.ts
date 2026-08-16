import { existsSync, rmSync, statSync } from 'node:fs';
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import {
  CH,
  type BulkDownload,
  type ExportRequest,
  type ExportResult,
  type SearchRequest,
  type SearchResponse,
} from '@shared/ipc';
import type { AppSettings, SourceRow } from '@shared/types';
import { getDb } from '@db/index';
import { listSources, setSourceStatus } from '@db/queries';
import { clearKey, hasKey, setKey } from './keychain';
import { cancelHarvest, startHarvest } from './harvester-host';
import { getGeometry } from './geometry-service';
import { runSearch } from './search-service';
import { runExport } from './export-service';
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
    exportFolder: getSetting('exportFolder'),
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

  /**
   * The download manager's view: which Tier B archives are on disk.
   *
   * `present` is checked against the filesystem rather than trusted from the row, because
   * these are large files in a user-visible folder and someone clearing space will delete
   * them without telling the app.
   */
  ipcMain.handle(CH.downloadsList, (): BulkDownload[] => {
    const rows = getDb()
      .prepare(
        `SELECT d.source_id, d.url, d.local_path, d.bytes, d.sha256, d.downloaded_at, s.name
         FROM bulk_downloads d JOIN sources s ON s.id = d.source_id
         ORDER BY d.downloaded_at DESC`,
      )
      .all() as {
      source_id: number;
      url: string;
      local_path: string;
      bytes: number | null;
      sha256: string | null;
      downloaded_at: string;
      name: string;
    }[];

    return rows.map((r) => ({
      sourceId: r.source_id,
      sourceName: r.name,
      url: r.url,
      localPath: r.local_path,
      bytes: r.bytes,
      sha256: r.sha256,
      downloadedAt: r.downloaded_at,
      present: existsSync(r.local_path),
    }));
  });

  /**
   * Deletes a cached archive to reclaim disk. The indexed features and their geometry stay
   * -- they are already in the catalog and do not need the archive again. Re-harvesting
   * that source later downloads it afresh.
   */
  ipcMain.handle(CH.downloadsRemove, (_e, sourceId: unknown) => {
    if (typeof sourceId !== 'number') throw new Error('downloads:remove expects a numeric source id');
    const db = getDb();
    const row = db
      .prepare('SELECT local_path, bytes FROM bulk_downloads WHERE source_id = ?')
      .get(sourceId) as { local_path: string; bytes: number | null } | undefined;
    if (!row) return { ok: false, freedBytes: 0 };

    let freedBytes = 0;
    if (existsSync(row.local_path)) {
      freedBytes = statSync(row.local_path).size;
      rmSync(row.local_path, { force: true });
    }
    db.prepare('DELETE FROM bulk_downloads WHERE source_id = ?').run(sourceId);
    console.log(`[downloads] removed ${row.local_path}, freed ${freedBytes} bytes`);
    return { ok: true, freedBytes };
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

  /**
   * Export writes straight to the configured folder and reports the path back.
   *
   * There is deliberately no save dialog: the brief bans modal dialogs anywhere in the
   * search-to-export path, and a native file picker per export is exactly that. The folder
   * is chosen once in Settings, which is outside the path, and `export:reveal` opens the
   * result in Explorer afterwards.
   */
  ipcMain.handle(CH.exportRun, async (_e, req: ExportRequest): Promise<ExportResult> => {
    validateExportRequest(req);
    try {
      return await runExport(req, (p) => {
        if (!win.isDestroyed()) win.webContents.send(CH.exportProgress, p);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!win.isDestroyed()) {
        win.webContents.send(CH.exportProgress, {
          phase: 'failed',
          done: 0,
          total: req.featureIds?.length ?? 0,
          message,
        });
      }
      throw err;
    }
  });

  // Same pipeline, no file written. Backs the live before/after vertex readout, which has
  // to run the real simplification -- a linear estimate is simply wrong for Visvalingam.
  ipcMain.handle(CH.exportPreview, async (_e, req: ExportRequest): Promise<ExportResult> => {
    validateExportRequest(req);
    return runExport({ ...req, previewOnly: true });
  });

  ipcMain.handle(CH.exportReveal, (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error('export:reveal expects a path');
    shell.showItemInFolder(path);
  });

  ipcMain.handle(CH.exportSetFolder, async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Where should exports be written?',
      defaultPath: getSetting('exportFolder'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false };
    setSetting('exportFolder', picked.filePaths[0]);
    return { ok: true, folder: picked.filePaths[0] };
  });
}

function validateExportRequest(req: ExportRequest): void {
  if (!req || !Array.isArray(req.featureIds) || req.featureIds.some((n) => typeof n !== 'number')) {
    throw new Error('export expects an array of numeric feature ids');
  }
  if (req.featureIds.length === 0) {
    throw new Error('Select at least one boundary before exporting.');
  }
  if (req.format !== 'geojson' && req.format !== 'svg') {
    throw new Error(`Unknown export format "${String(req.format)}"`);
  }
}
