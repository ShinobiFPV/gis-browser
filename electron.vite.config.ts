import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve('src/shared'),
  '@db': resolve('src/db'),
  '@resolve': resolve('src/resolve'),
  '@export': resolve('src/export'),
};

/**
 * The app version, baked in at build time.
 *
 * Not app.getVersion(): that reads the manifest at the APP PATH, which for
 * `electron out/main/cli.js` is a directory with no package.json -- so it silently
 * returns Electron's own version instead. The update check compares this against the
 * latest release, and a wrong answer either hides a real update or nags about one that
 * does not exist.
 */
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;

const define = { __APP_VERSION__: JSON.stringify(appVersion) };

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        // Two entries: the main process, and the harvester that main spawns as a
        // utilityProcess. The harvester must be a separate bundle -- it is loaded by
        // path at runtime, never imported by main.
        input: {
          index: resolve('src/main/index.ts'),
          harvester: resolve('src/harvester/index.ts'),
          // Headless harvest runner: `electron out/main/cli.js --list`
          cli: resolve('src/main/cli.ts'),
        },
      },
    },
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { preload: resolve('src/main/preload.ts') },
      },
    },
  },
  renderer: {
    define,
    root: resolve('src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
