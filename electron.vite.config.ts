import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve('src/shared'),
  '@db': resolve('src/db'),
  '@resolve': resolve('src/resolve'),
  '@export': resolve('src/export'),
};

export default defineConfig({
  main: {
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
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { preload: resolve('src/main/preload.ts') },
      },
    },
  },
  renderer: {
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
