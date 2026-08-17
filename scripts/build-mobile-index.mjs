/**
 * Builds the static search index shipped with GIS Browser Mobile.
 *
 * The PWA cannot harvest. It has no SQLite, no native module and no business
 * downloading a 2 GB catalog onto a phone, so the index is built here from a desktop
 * catalog and shipped as one compressed file.
 *
 * WHAT GOES IN: names, aliases, type, jurisdiction, source and bounding box.
 * WHAT STAYS OUT: geometry. That is the same decision the desktop app makes -- index
 * everything, fetch the shape you actually asked for -- and it is what keeps this file
 * small enough to put on a phone.
 *
 * Only Tier A features are included, PLUS countries. Tier B geometry arrives inside a bulk
 * archive from a host that sends no CORS headers, so a browser physically cannot fetch it;
 * listing those features would be offering the user boundaries the app cannot deliver.
 *
 * Countries are the exception because they are the one Tier B layer whose geometry is small
 * enough to ship: simplified, every country on earth is a few hundred kilobytes, and
 * scripts/build-world-pack.mjs bundles them with the app. A country listed here is therefore
 * deliverable -- from the pack rather than from the network. Every other Tier B feature is
 * not, and stays out.
 *
 *   node scripts/build-mobile-index.mjs [catalog.sqlite] [out.json]
 */
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbPath =
  process.argv[2] ?? join(process.env['APPDATA'] ?? '', 'gis-browser', 'data', 'catalog.sqlite');
const outPath = process.argv[3] ?? 'src/mobile/public/index.json.gz';
/** The uncompressed copy is for reading with your own eyes; it is never deployed. */
const keepRaw = process.argv.includes('--raw');

const db = new Database(dbPath, { readonly: true });

/** Dictionary encoding: repeated strings become integers. */
class Dict {
  constructor() {
    this.values = [];
    this.lookup = new Map();
  }
  id(value) {
    if (value === null || value === undefined) return -1;
    const held = this.lookup.get(value);
    if (held !== undefined) return held;
    const next = this.values.length;
    this.values.push(value);
    this.lookup.set(value, next);
    return next;
  }
}

const types = new Dict();
const jurisdictions = new Dict();
const sources = new Dict();

// Source metadata travels with the index: the mobile app needs the endpoint to fetch
// geometry, and the licence and attribution to write provenance into an export.
//
// identity_field is not optional metadata. Elections Canada's 2025 layer publishes one row
// per polygon, so a phone that asked for a single OBJECTID would be handed a fragment of a
// riding and would have no way to know it. verified_at travels for the opposite reason --
// nothing depends on it, but an export's provenance block is worth less without it.
const sourceRows = db
  .prepare(
    `SELECT id, name, kind, endpoint, layer_id, licence, attribution, vintage, source_srid,
            identity_field, verified_at
       FROM sources
      WHERE tier = 'A'
         OR id IN (SELECT DISTINCT source_id FROM features WHERE feature_type = 'country')`,
  )
  .all();
const sourceById = new Map(sourceRows.map((s) => [s.id, s]));

// A country with no harvested geometry cannot go in the pack, so it must not go in the
// index either -- it would search, rank, open, and then fail with nothing to show.
const features = db
  .prepare(
    `SELECT f.id, f.official_name, f.feature_type, f.jurisdiction, f.source_id,
            f.source_feature_id, f.minx, f.miny, f.maxx, f.maxy
       FROM features f JOIN sources s ON s.id = f.source_id
      WHERE s.tier = 'A'
         OR (f.feature_type = 'country'
             AND EXISTS (SELECT 1 FROM geometries g WHERE g.feature_id = f.id))
      ORDER BY f.official_name`,
  )
  .all();

const aliasesByFeature = new Map();
for (const a of db.prepare('SELECT feature_id, alias FROM aliases').all()) {
  const list = aliasesByFeature.get(a.feature_id);
  if (list) list.push(a.alias);
  else aliasesByFeature.set(a.feature_id, [a.alias]);
}

/** Three decimal places is ~110 m, which is far finer than a locator dot needs. */
const round = (n) => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);

const rows = [];
let aliasCount = 0;
for (const f of features) {
  if (!sourceById.has(f.source_id)) continue;

  // The official name is always the first alias, so it is not stored twice.
  const all = aliasesByFeature.get(f.id) ?? [];
  const extra = [...new Set(all.filter((a) => a !== f.official_name))];
  aliasCount += extra.length;

  rows.push([
    f.id,
    f.official_name,
    types.id(f.feature_type),
    jurisdictions.id(f.jurisdiction),
    sources.id(f.source_id),
    f.source_feature_id,
    round(f.minx),
    round(f.miny),
    round(f.maxx),
    round(f.maxy),
    extra,
  ]);
}

const payload = {
  // Bumped whenever the shape changes, so a cached index from an older build is replaced
  // rather than misread.
  format: 1,
  built: new Date().toISOString().slice(0, 10),
  types: types.values,
  jurisdictions: jurisdictions.values,
  sources: sources.values.map((id) => {
    const s = sourceById.get(id);
    return [
      s.id,
      s.name,
      s.kind,
      s.endpoint,
      s.layer_id,
      s.licence,
      s.attribution,
      s.vintage,
      s.source_srid,
      s.identity_field,
      s.verified_at,
    ];
  }),
  jurisdictionLabels: Object.fromEntries(
    db.prepare('SELECT code, label FROM jurisdictions').all().map((j) => [j.code, j.label]),
  ),
  features: rows,
};

const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json), { level: 9 });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gz);
if (keepRaw) writeFileSync(outPath.replace(/\.gz$/, ''), json);

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
const countries = rows.filter((r) => types.values[r[2]] === 'country').length;
console.log(`features      : ${rows.length}  (${countries} countries, bundled with geometry)`);
console.log(`aliases       : ${aliasCount}`);
console.log(`sources       : ${payload.sources.length}`);
console.log(`types         : ${types.values.length}`);
console.log(`jurisdictions : ${jurisdictions.values.length}`);
console.log(`raw           : ${mb(json.length)}`);
console.log(`gzipped       : ${mb(gz.length)}   <- what actually goes over the wire`);
console.log(`written       : ${outPath}`);
