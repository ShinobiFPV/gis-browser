#!/usr/bin/env node
/**
 * Catalog inspector: prints what the harvester actually put in the database and checks
 * the invariants that matter.
 *
 *   npm run inspect
 *   npm run inspect -- "C:\\path\\to\\catalog.sqlite" "parry island first nation"
 *
 * Runs under plain Node (better-sqlite3 is N-API, so the Electron build loads here too).
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';
import Database from 'better-sqlite3';

function defaultDbPath() {
  const appData =
    process.env.APPDATA ?? join(process.env.HOME ?? '', 'Library', 'Application Support');
  return join(appData, 'gis-browser', 'data', 'catalog.sqlite');
}

const dbPath = process.argv[2] ?? defaultDbPath();
const query = process.argv[3] ?? 'parry island first nation';

if (!existsSync(dbPath)) {
  console.error(`No catalog at ${dbPath}. Run a harvest first.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const one = (sql) => Object.values(db.prepare(sql).get())[0];
const pad = (v, n) => String(v).padStart(n);

console.log(`catalog: ${dbPath}\n`);

console.log('=== counts ===');
const counts = {
  sources: one('SELECT COUNT(*) FROM sources'),
  harvested: one("SELECT COUNT(*) FROM sources WHERE status = 'ok'"),
  failed: one("SELECT COUNT(*) FROM sources WHERE status = 'failed'"),
  features: one('SELECT COUNT(*) FROM features'),
  aliases: one('SELECT COUNT(*) FROM aliases'),
  geometries: one('SELECT COUNT(*) FROM geometries'),
};
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${pad(v, 8)}`);

console.log('\n=== invariants ===');
const fts = one('SELECT COUNT(*) FROM features_fts');
const rtree = one('SELECT COUNT(*) FROM features_rtree');
const withBbox = one('SELECT COUNT(*) FROM features WHERE minx IS NOT NULL');
/**
 * Containment was the right test until M6 brought in Natural Earth's world layers. The
 * United States and Greenland are legitimate context features that overlap Canada and
 * extend well past it, so the invariant is now that every bbox must INTERSECT Canada --
 * which still catches the failure that mattered, a layer landing in the wrong hemisphere.
 */
const disjoint = one(
  'SELECT COUNT(*) FROM features WHERE minx IS NOT NULL AND (maxx < -143.5 OR minx > -50 OR maxy < 39 OR miny > 86)',
);

/**
 * A bbox wider than Canada is not wrong by itself, but one spanning most of the planet
 * matches every spatial query and makes the R-tree useless. dropDistantParts exists to
 * prevent exactly this.
 */
const global = one('SELECT COUNT(*) FROM features WHERE minx IS NOT NULL AND (maxx - minx) > 200');
const orphanRtree = one('SELECT COUNT(*) FROM features_rtree WHERE id NOT IN (SELECT id FROM features)');

const check = (label, ok, detail) => console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
check('FTS index matches alias count', fts === counts.aliases, `${fts} vs ${counts.aliases}`);
check('R-tree matches features with a bbox', rtree === withBbox, `${rtree} vs ${withBbox}`);
check('no orphaned R-tree entries', orphanRtree === 0, `${orphanRtree} orphans`);
check('every bbox overlaps Canada', disjoint === 0, `${disjoint} disjoint`);
check('no bbox spans the globe', global === 0, `${global} wider than 200 deg`);

const extent = db.prepare('SELECT MIN(minx) a, MAX(maxx) b, MIN(miny) c, MAX(maxy) d FROM features').get();
if (extent.a !== null) {
  console.log(
    `  extent: lon ${extent.a.toFixed(2)}..${extent.b.toFixed(2)}  lat ${extent.c.toFixed(2)}..${extent.d.toFixed(2)}`,
  );
}

console.log('\n=== features by type ===');
for (const r of db
  .prepare('SELECT feature_type, COUNT(*) n FROM features GROUP BY feature_type ORDER BY n DESC')
  .all())
  console.log(`  ${r.feature_type.padEnd(32)} ${pad(r.n, 7)}`);

console.log('\n=== failed sources ===');
const failed = db.prepare("SELECT id, name, endpoint FROM sources WHERE status = 'failed' ORDER BY id").all();
if (!failed.length) console.log('  (none)');
for (const r of failed) console.log(`  ${pad(r.id, 3)}  ${r.name}\n       ${r.endpoint}`);

console.log(`\n=== FTS probe: "${query}" (no LLM) ===`);
const hits = db
  .prepare(
    `SELECT f.official_name, f.feature_type, f.jurisdiction, s.name AS source, a.alias, bm25(features_fts) AS score
     FROM features_fts
     JOIN aliases a ON a.id = features_fts.rowid
     JOIN features f ON f.id = a.feature_id
     JOIN sources s ON s.id = f.source_id
     WHERE features_fts MATCH ?
     ORDER BY score LIMIT 10`,
  )
  .all(`"${query}"`);
if (!hits.length) console.log('  (no hits)');
for (const h of hits)
  console.log(
    `  ${h.score.toFixed(2)}  ${h.official_name}  [${h.feature_type}/${h.jurisdiction}]  via "${h.alias}"\n        <- ${h.source}`,
  );
