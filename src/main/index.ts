import { join } from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import { closeDb, openDb } from '@db/index';
import { registerIpc } from './ipc';
import { scheduleStartupCheck } from './updates';
import { killHarvest } from './harvester-host';

/**
 * Main process: one window, one database, one harvester child.
 * The Anthropic client lives here too (M4) so no key ever reaches the renderer.
 */

const isDev = !app.isPackaged;

// Pin the app name so userData is the same directory however the app is launched.
// Without this, `electron .` resolves the name from package.json but
// `electron out/main/cli.js` falls back to "Electron", and the headless harvester would
// quietly fill a different database from the one the UI reads.
app.setName('gis-browser');

function paths() {
  const dataDir = join(app.getPath('userData'), 'data');
  return { dataDir, dbPath: join(dataDir, 'catalog.sqlite') };
}

function createWindow(dbPath: string, dataDir: string): BrowserWindow {
  // Four dense panes want width, but a window bigger than the work area opens partly
  // off-screen -- on a 1600x900 laptop the Export pane simply is not reachable.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1600, Math.max(1100, work.width - 40));
  const height = Math.min(1000, Math.max(700, work.height - 40));

  const w = new BrowserWindow({
    width,
    height,
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

  // A window that never appears is the worst way to fail: no error, no UI, nothing to
  // report. Say why, and show the window anyway so the failure is at least visible.
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] renderer failed to load (${code} ${desc}) from ${url}`);
    if (!w.isDestroyed()) w.show();
  });
  w.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[main] renderer process gone: ${details.reason} (exitCode ${details.exitCode})`);
  });
  // Renderer console output is invisible without devtools; forward it so a packaged
  // build can still be debugged from a terminal.
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      console.error(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });
  setTimeout(() => {
    if (!w.isDestroyed() && !w.isVisible()) {
      console.warn('[main] ready-to-show did not fire within 8s; showing the window regardless');
      w.show();
    }
  }, 8000);

  // External links open in the real browser, never inside the app shell.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  registerIpc(w, { dbPath, dataDir });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    // The renderer's dev harness reads ?demo= and ?settings from location.search (see
    // App.tsx). electron-vite owns ELECTRON_RENDERER_URL and overwrites any value set
    // before it spawns Electron, so the query cannot be smuggled in that way; these two
    // env vars are the supported channel. Development only -- a packaged build takes the
    // loadFile branch below and can reach neither.
    const params = new URLSearchParams();
    const demo = process.env['GIS_DEMO'];
    if (demo) params.set('demo', demo);
    if (process.env['GIS_SETTINGS']) params.set('settings', '1');
    // Opens the collapsed discovery section, so a screenshot can show it without a click.
    if (process.env['GIS_DISCOVERY']) params.set('discovery', '1');

    const query = params.toString();
    void w.loadURL(query ? `${devUrl}${devUrl.includes('?') ? '&' : '?'}${query}` : devUrl);
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  return w;
}

/**
 * Headless health check for a PACKAGED build: `"GIS Browser.exe" --smoke`.
 *
 * Opens the catalog, runs every migration, seeds the registry, prints a summary and
 * exits without ever creating a window. It exists because the one thing packaging can
 * silently break is the native module: better-sqlite3 has to be unpacked from the asar
 * to be loadable, and a broken unpack builds perfectly, installs perfectly, and then
 * dies on the first query. Nothing short of running the packaged binary catches it.
 *
 * The CLI cannot serve this purpose. It is a separate entry point reached by passing a
 * script path to Electron, which a packaged app does not accept.
 */
function runSmokeTest(dbPath: string): number {
  console.log(`[smoke] opening ${dbPath}`);
  const db = openDb(dbPath);

  const sources = (db.prepare('SELECT COUNT(*) n FROM sources').get() as { n: number }).n;
  const tierB = (db.prepare("SELECT COUNT(*) n FROM sources WHERE tier = 'B'").get() as { n: number }).n;
  const version = db.pragma('user_version', { simple: true }) as number;

  console.log(`[smoke] schema version ${version}`);
  console.log(`[smoke] ${sources} sources seeded (${tierB} tier B)`);
  console.log(`[smoke] electron ${process.versions.electron}, node ${process.versions.node}`);

  if (sources === 0) {
    console.error('[smoke] FAILED: the registry seeded no sources');
    return 1;
  }
  if (version < 1) {
    console.error('[smoke] FAILED: no migration ran');
    return 1;
  }

  console.log('[smoke] ok');
  return 0;
}

void app.whenReady().then(() => {
  const { dbPath, dataDir } = paths();

  if (process.argv.includes('--smoke')) {
    let code = 1;
    try {
      code = runSmokeTest(dbPath);
    } catch (err) {
      console.error(`[smoke] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    } finally {
      closeDb();
    }
    app.exit(code);
    return;
  }

  console.log(`[main] ready; opening ${dbPath}`);
  openDb(dbPath);
  console.log('[main] database open; creating window');
  createWindow(dbPath, dataDir);
  console.log('[main] window created');

  // Background, delayed, and never blocking: the first seconds after launch belong to
  // opening the catalog and painting a window. The renderer polls update:status.
  scheduleStartupCheck((status) => {
    if (status.updateAvailable) {
      console.log(`[main] update available: ${status.latestVersion ?? '?'}`);
    }
  });

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
