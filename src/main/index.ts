import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { closeDb, openDb } from '@db/index';
import { registerIpc } from './ipc';
import { killHarvest } from './harvester-host';

/**
 * Main process: one window, one database, one harvester child.
 * The Anthropic client lives here too (M4) so no key ever reaches the renderer.
 */

const isDev = !app.isPackaged;

function paths() {
  const dataDir = join(app.getPath('userData'), 'data');
  return { dataDir, dbPath: join(dataDir, 'catalog.sqlite') };
}

function createWindow(dbPath: string, dataDir: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d1117',
    title: 'GIS Browser',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  w.once('ready-to-show', () => w.show());

  // External links open in the real browser, never inside the app shell.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  registerIpc(w, { dbPath, dataDir });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    void w.loadURL(devUrl);
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return w;
}

app.whenReady().then(() => {
  const { dbPath, dataDir } = paths();
  openDb(dbPath);
  createWindow(dbPath, dataDir);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(dbPath, dataDir);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killHarvest();
  closeDb();
});

// A crash in main must not leave a half-written catalog behind.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception', err);
  killHarvest();
  closeDb();
  process.exit(1);
});
