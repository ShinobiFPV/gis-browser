/**
 * Injected by electron-vite from package.json at build time.
 *
 * app.getVersion() cannot be trusted for this: it reads the manifest at the app path,
 * which for `electron out/main/cli.js` has none, so it returns Electron's version.
 */
declare const __APP_VERSION__: string;
