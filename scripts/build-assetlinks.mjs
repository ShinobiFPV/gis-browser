/**
 * Writes the Digital Asset Links file that turns the Android app into a TWA.
 *
 *   node scripts/build-assetlinks.mjs [SHA-256 fingerprint]...
 *
 * This one file is the difference between a Trusted Web Activity and a browser tab with an
 * icon. Chrome fetches https://<host>/.well-known/assetlinks.json on launch, checks that it
 * names the installed package AND the certificate the package was actually signed with, and
 * only then hides the URL bar. Every part of that check fails silently and identically:
 * the app opens, the site works, and there is a browser chrome bar across the top forever.
 *
 * Fingerprints come from android/twa-manifest.json, where `bubblewrap fingerprint add`
 * records them, or from the command line for the case that matters most:
 *
 *   IF YOU PUBLISH THROUGH GOOGLE PLAY, THE FINGERPRINT HERE IS GOOGLE'S, NOT YOURS.
 *
 * Play App Signing re-signs your upload with a key Google holds, so the certificate on the
 * installed app is not the one in your keystore. The value to publish is the SHA-256 under
 * Play Console -> Setup -> App integrity. Using the upload key's fingerprint instead is the
 * single most common reason a TWA that verified locally shows a URL bar once installed from
 * Play -- and because both are real fingerprints of real keys, nothing anywhere says so.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'android', 'twa-manifest.json');
const outPath = join(root, 'src', 'mobile', 'public', '.well-known', 'assetlinks.json');

/** 32 bytes, uppercase hex, colon-separated -- the form keytool and Play both print. */
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/**
 * `--check` runs at deploy time and only ever WARNS.
 *
 * It cannot fail the deploy, because the very first deploy has to happen before the app can
 * exist: bubblewrap fetches the icons over HTTP to generate the project, so there is no
 * signing key and no fingerprint yet. Blocking here would make the documented order
 * impossible. Warning is still worth it -- a deploy that quietly drops the asset links is
 * indistinguishable from a working one until somebody opens the app and sees a URL bar.
 */
if (process.argv.includes('--check')) {
  const built = join(root, 'dist-mobile', '.well-known', 'assetlinks.json');
  let live = [];
  try {
    live = JSON.parse(readFileSync(built, 'utf8'))[0]?.target?.sha256_cert_fingerprints ?? [];
  } catch {
    live = [];
  }

  if (live.length === 0) {
    console.warn(
      `\n  !  This build serves no Digital Asset Links.\n` +
        `     The site will work; the Android app will show a URL bar, because Chrome cannot\n` +
        `     verify it against https://${manifest.host}/.well-known/assetlinks.json.\n` +
        `     Expected, if the app has not been signed yet. Otherwise: npm run twa:assetlinks\n`,
    );
  } else {
    console.log(`Digital Asset Links: ${live.length} fingerprint(s) for ${manifest.packageId}.`);
  }
  process.exit(0);
}

/**
 * Command-line fingerprints REPLACE the manifest's rather than adding to them.
 *
 * An asset links file lists every certificate allowed to speak for the site, so a stale
 * entry left behind from a rotated or leaked key is not clutter -- it is an app you no
 * longer control still being trusted by your origin.
 */
const fromArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const fingerprints = (
  fromArgs.length > 0 ? fromArgs : (manifest.fingerprints ?? []).map((f) => f.value ?? f)
).map((f) => String(f).trim().toUpperCase());

if (fingerprints.length === 0) {
  console.error(
    `No signing fingerprints.\n\n` +
      `Add the one Chrome will actually see:\n\n` +
      `  from Play App Signing (if you publish through Play -- this is the usual answer):\n` +
      `    node scripts/build-assetlinks.mjs <SHA-256 from Play Console -> App integrity>\n\n` +
      `  from your own keystore (sideloading, or Play upload key only):\n` +
      `    keytool -list -v -keystore android/android.keystore -alias upload\n`,
  );
  process.exit(1);
}

for (const f of fingerprints) {
  if (!FINGERPRINT_RE.test(f)) {
    console.error(
      `"${f}" is not a SHA-256 certificate fingerprint.\n\n` +
        `Expected 32 colon-separated hex pairs, e.g.\n` +
        `  A1:B2:C3:...:F0  (95 characters)\n\n` +
        `A SHA-1 fingerprint is half this length and will not verify -- Chrome requires SHA-256.`,
    );
    process.exit(1);
  }
}

if (!manifest.packageId) {
  console.error(`android/twa-manifest.json has no packageId, so there is nothing to link the site to.`);
  process.exit(1);
}

const assetLinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: manifest.packageId,
      sha256_cert_fingerprints: fingerprints,
    },
  },
];

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(assetLinks, null, 2) + '\n');

console.log(`package     : ${manifest.packageId}`);
console.log(`host        : ${manifest.host}`);
for (const f of fingerprints) console.log(`fingerprint : ${f}`);
console.log(`written     : ${outPath.replace(root + '\\', '').replace(root + '/', '')}`);
console.log(
  `\nThis is only live once it is SERVED. Run \`npm run mobile:deploy\`, then confirm:\n` +
    `  https://${manifest.host}/.well-known/assetlinks.json`,
);
