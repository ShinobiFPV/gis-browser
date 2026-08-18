/**
 * Regenerates the Android TWA project from android/twa-manifest.json.
 *
 *   node scripts/twa-update.mjs
 *
 * A wrapper around `bubblewrap update` that exists for one reason: to pass the app's real
 * version through. Bubblewrap's own non-interactive escape hatch, --skipVersionUpgrade,
 * generates `versionName ""` -- an APK with no version name at all, which Play rejects on
 * upload and which makes a sideloaded build impossible to tell apart from any other. Passing
 * --appVersionName instead sets the name AND increments versionCode, which is the rule Play
 * actually enforces between uploads.
 *
 * The version comes from package.json, the same place the desktop app and the mobile
 * exporter's provenance block get it. Three copies of a version number is two too many.
 *
 * Note this MUTATES android/twa-manifest.json: bubblewrap writes the incremented
 * appVersionCode back into it. That is correct and the file is committed for exactly that
 * reason -- the next release has to know what the last one used.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log(`Generating the Android project at version ${version}.`);

// `shell: true` because bubblewrap is installed as a .cmd shim on Windows, which
// CreateProcess cannot execute directly.
const result = spawnSync('bubblewrap', ['update', `--appVersionName=${version}`], {
  cwd: join(root, 'android'),
  stdio: 'inherit',
  shell: true,
});

if (result.error) throw result.error;

if (result.status !== 0) {
  console.error(
    '\nbubblewrap update failed.\n\n' +
      'The usual cause is that it could not fetch the icons: it downloads iconUrl and\n' +
      'maskableIconUrl over HTTP to rasterise them into the project, so the site has to be\n' +
      'deployed BEFORE the app can be generated. Run `npm run mobile:deploy` first.',
  );
  process.exit(result.status ?? 1);
}
