/**
 * Builds the bundled country pack shipped with GIS Browser Mobile.
 *
 * Every other boundary in the mobile app is fetched from its own service on demand, which
 * works only because those services send CORS headers. The countries do not come from a
 * service at all -- they come from a Natural Earth archive on a host that sends none, so a
 * browser cannot fetch them however it asks. Their geometry is therefore simplified here
 * and shipped with the app.
 *
 * Simplification is Visvalingam with `keep-shapes`, the same as the desktop exporter, and
 * for the same reason: without it, whole small polygons vanish once their area drops below
 * the threshold, and a country losing its islands is exactly the failure this app exists to
 * prevent. Run scripts/measure-world-pack.mjs first to see what each retention costs.
 *
 *   node scripts/build-world-pack.mjs [catalog.sqlite] [retention%] [out.json.gz]
 *
 * The default retention is 5%, which measured at roughly a third of a megabyte gzipped
 * while keeping every island large enough to see on a phone.
 */
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const mapshaper = require('mapshaper');

const dbPath =
  process.argv[2] ?? join(process.env['APPDATA'] ?? '', 'gis-browser', 'data', 'catalog.sqlite');
const retention = Number(process.argv[3] ?? 5);
const outPath = process.argv[4] ?? 'src/mobile/public/world.json.gz';

if (!Number.isFinite(retention) || retention <= 0 || retention > 100) {
  throw new Error(`Retention must be a percentage between 0 and 100, not ${process.argv[3]}`);
}

const db = new Database(dbPath, { readonly: true });

/*
 * Keyed on the FEATURE ID, which is what the mobile index carries.
 *
 * Not the country code and not the name: the pack and the index are two files that have to
 * line up, and the only identifier both of them get from the same place is the row id.
 */
const rows = db
  .prepare(
    `SELECT f.id, f.official_name, g.geometry_json
       FROM features f JOIN geometries g ON g.feature_id = f.id
      WHERE f.feature_type = 'country'
      ORDER BY f.official_name`,
  )
  .all();

if (rows.length === 0) {
  throw new Error(
    `No country geometry in ${dbPath}. Harvest the Natural Earth countries source first -- ` +
      `the pack cannot be built from an index alone.`,
  );
}

const input = JSON.stringify({
  type: 'FeatureCollection',
  features: rows.map((r) => ({
    type: 'Feature',
    properties: { i: r.id },
    geometry: JSON.parse(r.geometry_json),
  })),
});

const output = await mapshaper.applyCommands(
  `-i in.json -simplify visvalingam keep-shapes ${retention}% -o out.json precision=0.001`,
  { 'in.json': input },
);

const simplified = Buffer.from(output['out.json']).toString('utf8');
const parsed = JSON.parse(simplified);

if (!Array.isArray(parsed.features)) {
  throw new Error(`mapshaper returned a ${parsed.type} rather than a FeatureCollection.`);
}
if (parsed.features.length !== rows.length) {
  throw new Error(
    `Simplification returned ${parsed.features.length} countries for ${rows.length} inputs. ` +
      `keep-shapes should make that impossible; refusing to ship a pack that lost a country.`,
  );
}
for (const f of parsed.features) {
  if (typeof f.properties?.i !== 'number') {
    throw new Error('A country lost its feature id in simplification, so it cannot be matched to the index.');
  }
  if (!f.geometry) {
    throw new Error(
      `"${f.properties.i}" simplified to null geometry at ${retention}%. Raise the retention.`,
    );
  }
}

// Properties beyond the id are dead weight on a phone: the name, type and jurisdiction all
// come from the index, which is already in memory by the time the pack is read.
const packed = JSON.stringify({
  type: 'FeatureCollection',
  features: parsed.features.map((f) => ({ properties: { i: f.properties.i }, geometry: f.geometry })),
});

const gz = gzipSync(Buffer.from(packed), { level: 9 });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gz);

const countVertices = (geometry) => {
  let n = 0;
  const visit = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') n++;
    else for (const x of c) visit(x);
  };
  visit(geometry.coordinates);
  return n;
};

const before = rows.reduce((n, r) => n + countVertices(JSON.parse(r.geometry_json)), 0);
const after = parsed.features.reduce((n, f) => n + countVertices(f.geometry), 0);

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
console.log(`countries : ${rows.length}`);
console.log(`retention : ${retention}%`);
console.log(`vertices  : ${before.toLocaleString()} -> ${after.toLocaleString()}`);
console.log(`raw       : ${mb(packed.length)}`);
console.log(`gzipped   : ${mb(gz.length)}   <- what actually ships`);
console.log(`written   : ${outPath}`);
