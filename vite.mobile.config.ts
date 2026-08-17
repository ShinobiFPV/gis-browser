import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * GIS Browser Mobile — the PWA build.
 *
 * A separate Vite config rather than a separate package, because the whole point is to
 * share the desktop app's search and export layers verbatim. Two package.json files would
 * mean two copies of proj4 and two chances for the mobile results to drift from the
 * desktop ones.
 *
 * `base` is relative so the built app works from a repo subpath on GitHub Pages, from the
 * root of a custom domain, and from inside a Bubblewrap TWA, without rebuilding.
 */

const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  root: resolve('src/mobile'),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@resolve': resolve('src/resolve'),
      '@export': resolve('src/export'),
      '@mobile': resolve('src/mobile'),
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve('dist-mobile'),
    emptyOutDir: true,
    // A phone on a newsroom LTE connection is the target, so the budget is real.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: { index: resolve('src/mobile/index.html') },
    },
  },
  server: { port: 5180 },
});
