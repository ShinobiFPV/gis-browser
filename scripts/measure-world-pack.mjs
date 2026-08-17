/**
 * How big is a bundled, simplified country pack, at each retention?
 *
 *   node scripts/measure-world-pack.mjs [catalog.sqlite]
 *
 * This is how the 5% default in scripts/build-world-pack.mjs was chosen, and it is kept so
 * the number can be re-derived rather than inherited. Prints nothing and writes nothing --
 * run it, read the gzipped column, then build the real pack at whatever it says.
 */
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const mapshaper = require('mapshaper');

const db = new Database(process.argv[2], { readonly: true });
const rows = db
  .prepare(
    `SELECT f.id, f.official_name, g.geometry_json
       FROM features f JOIN geometries g ON g.feature_id = f.id
      WHERE f.feature_type = 'country'`,
  )
  .all();

const fc = {
  type: 'FeatureCollection',
  features: rows.map((r) => ({
    type: 'Feature',
    properties: { i: r.id },
    geometry: JSON.parse(r.geometry_json),
  })),
};
const raw = JSON.stringify(fc);
console.log('countries          :', rows.length);
console.log('raw geojson        :', (raw.length / 1e6).toFixed(2), 'MB');
console.log('raw gzipped        :', (gzipSync(Buffer.from(raw), { level: 9 }).length / 1e6).toFixed(2), 'MB');

for (const pct of ['15%', '5%', '2%']) {
  const out = await mapshaper.applyCommands(
    `-i in.json -simplify visvalingam keep-shapes ${pct} -o out.json precision=0.001`,
    { 'in.json': raw },
  );
  const s = Buffer.from(out['out.json']).toString();
  console.log(
    `simplified ${pct.padStart(3)}     : ${(s.length / 1e6).toFixed(2)} MB raw, ` +
      `${(gzipSync(Buffer.from(s), { level: 9 }).length / 1e6).toFixed(2)} MB gzipped`,
  );
}
