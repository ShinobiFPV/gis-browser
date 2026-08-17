import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The same build-time constant the app ships with.
 *
 * Both real configs bake this in from package.json, so a test importing a module that
 * writes the version into an exported file -- which the mobile exporter does, into every
 * provenance block -- would otherwise fail on a bare ReferenceError rather than on anything
 * to do with what it was testing.
 */
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@db': resolve('src/db'),
      '@resolve': resolve('src/resolve'),
      '@export': resolve('src/export'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
