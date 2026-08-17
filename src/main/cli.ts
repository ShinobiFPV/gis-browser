import { dirname, join } from 'node:path';
import { app } from 'electron';
import { closeDb, openDb } from '@db/index';
import { recordHarvestResult, setSourceStatus } from '@db/queries';
import type { SourceRow } from '@shared/types';
import { HttpClient } from '../harvester/http';
import { runSource, UnsupportedSourceError } from '../harvester/run-source';
import { resolve as resolveQuery } from '@resolve/resolve';
import { getGeometry } from './geometry-service';
import { runSearch } from './search-service';
import { runExport } from './export-service';
import { DEFAULT_SVG_SRID } from '@shared/projections';
import { asText } from '@shared/scalar';
import { runDiscovery } from '../harvester/discovery/run-discovery';
import { DISCOVERY_CATALOGS } from '@db/seed/sources';

/** The CKAN portals discovery walks. Hub is always crawled and needs no root. */
const CKAN_ROOTS = DISCOVERY_CATALOGS.filter((c) => c.kind === 'ckan').map((c) => ({
  name: c.name,
  endpoint: c.endpoint,
}));

/**
 * Headless harvest runner.
 *
 * Runs under Electron (so it gets the same native better-sqlite3 build as the app) but
 * opens no window. Exists so a harvest can be driven and verified from a terminal without
 * clicking through the UI, and so M8 can offer a scripted first-run warm-up.
 *
 *   electron out/main/cli.js --type federal_electoral_district
 *   electron out/main/cli.js --id 8 --id 9
 *   electron out/main/cli.js --name "Aboriginal Lands"
 */

// Must match src/main/index.ts, or the CLI harvests into a different database from the
// one the UI opens: Electron derives userData from the app name, and a bare script path
// makes that name "Electron".
app.setName('gis-browser');

interface Args {
  ids: number[];
  types: string[];
  names: string[];
  list: boolean;
  limit: number | null;
  /** Look a place up and fetch its geometry, exercising the whole M2 path. */
  find: string | null;
  /** Route --find through the Claude parse and rank passes. */
  llm: boolean;
  /** Export the results of --find. 'geojson' or 'svg'. */
  exportFormat: 'geojson' | 'svg' | null;
  /** Percentage of vertices to retain. 100 means no simplification. */
  retention: number;
  /** Export every candidate as one file rather than just the top hit. */
  exportAll: boolean;
  /** EPSG code for an SVG export. */
  srid: number;
  /** Catalog feature ids to export directly, bypassing search. Repeatable. */
  featureIds: number[];
  /** Run the M7 discovery crawlers with these search terms. Repeatable. */
  discover: string[];
  /** Show what discovery has already found, best first. */
  candidates: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    ids: [],
    types: [],
    names: [],
    list: false,
    limit: null,
    find: null,
    llm: false,
    exportFormat: null,
    retention: 100,
    exportAll: false,
    srid: DEFAULT_SVG_SRID,
    featureIds: [],
    discover: [],
    candidates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--id' && next) {
      out.ids.push(Number(next));
      i++;
    } else if (a === '--type' && next) {
      out.types.push(next);
      i++;
    } else if (a === '--name' && next) {
      out.names.push(next);
      i++;
    } else if (a === '--limit' && next) {
      out.limit = Number(next);
      i++;
    } else if (a === '--find' && next) {
      out.find = next;
      i++;
    } else if (a === '--export' && next) {
      if (next !== 'geojson' && next !== 'svg') {
        throw new Error(`--export takes "geojson" or "svg", not "${next}"`);
      }
      out.exportFormat = next;
      i++;
    } else if (a === '--feature' && next) {
      out.featureIds.push(Number(next));
      i++;
    } else if (a === '--retention' && next) {
      out.retention = Number(next);
      i++;
    } else if (a === '--srid' && next) {
      out.srid = Number(next);
      i++;
    } else if (a === '--discover' && next) {
      out.discover.push(next);
      i++;
    } else if (a === '--candidates') {
      out.candidates = true;
    } else if (a === '--list') {
      out.list = true;
    } else if (a === '--llm') {
      out.llm = true;
    } else if (a === '--all') {
      out.exportAll = true;
    }
  }
  return out;
}

function selectSources(db: ReturnType<typeof openDb>, args: Args): SourceRow[] {
  const all = db.prepare('SELECT * FROM sources ORDER BY id').all() as SourceRow[];
  if (args.ids.length === 0 && args.types.length === 0 && args.names.length === 0) return [];
  const chosen = all.filter(
    (s) =>
      args.ids.includes(s.id) ||
      args.types.includes(s.feature_type) ||
      args.names.some((n) => s.name.toLowerCase().includes(n.toLowerCase())),
  );
  return args.limit ? chosen.slice(0, args.limit) : chosen;
}

/**
 * Exercises the whole M2 path from a terminal: name lookup, lazy geometry fetch, cache
 * write, then a second read that must come from the cache.
 */
async function runFind(
  db: ReturnType<typeof openDb>,
  text: string,
  limit: number,
  useLlm: boolean,
  args: Args,
): Promise<number> {
  // With --llm this is the exact path the UI takes, including the fallback to the local
  // resolver when the key is missing or the API misbehaves.
  let candidates;
  let parsed;
  let timings;
  let notes: string[];

  if (useLlm) {
    const r = await runSearch({ prompt: text, useLlm: true, limit });
    ({ candidates, parsed } = r);
    timings = r.timings;
    notes = [];
  } else {
    const r = resolveQuery(db, text, { limit });
    ({ candidates, parsed } = r);
    timings = r.timings;
    notes = r.notes;
  }
  const result = { candidates, parsed, timings };

  console.log(`\n[cli] parsed: names=[${parsed.placeNames.join(' | ')}]`);
  console.log(
    `      type=${parsed.featureTypeHint ?? '—'} jurisdiction=${parsed.jurisdictionHint ?? '—'} ` +
      `vintage=${parsed.vintageHint ?? '—'} (${parsed.via})`,
  );
  console.log(`      ${parsed.notes}`);
  for (const n of notes) console.log(`      note: ${n}`);
  console.log(
    `      timings: parse ${result.timings.parseMs}ms, match ${result.timings.matchMs}ms, ` +
      `rank ${result.timings.rankMs}ms`,
  );

  if (candidates.length === 0) {
    console.log(`[cli] no candidates for "${text}"`);
    return 1;
  }

  console.log(`\n[cli] ${candidates.length} candidate(s):`);
  for (const [i, c] of candidates.entries()) {
    console.log(
      `  ${i + 1}. ${c.matchScore.toFixed(3)}  #${c.featureId}  ${c.officialName}  ` +
        `[${c.featureType}/${c.jurisdiction ?? '—'}]  cached=${c.hasCachedGeometry}`,
    );
    console.log(`         via ${c.matchedVia} on "${c.matchedAlias}"  <- ${c.sourceName}`);
    console.log(`         ${c.justification ?? ''}`);
  }

  const top = candidates[0]!;
  console.log(`\n[cli] fetching geometry for "${top.officialName}" (feature ${top.featureId})`);

  const first = await getGeometry(top.featureId);
  console.log(
    `  ${first.fromCache ? 'CACHE' : 'NETWORK'}  ${first.vertexCount} vertices, ` +
      `${first.partCount} part(s), ${first.fetchMs}ms`,
  );
  console.log(`  bbox: ${first.bbox ? first.bbox.map((n) => n.toFixed(4)).join(', ') : '(none)'}`);
  console.log(`  attribution: ${first.attribution ?? '(none)'}`);
  console.log(`  geometry type: ${(first.geometry as { type?: string }).type ?? '?'}`);

  const second = await getGeometry(top.featureId);
  console.log(
    `  second read: ${second.fromCache ? 'CACHE' : 'NETWORK'} in ${second.fetchMs}ms ` +
      `(${second.vertexCount} vertices)`,
  );
  if (!second.fromCache) {
    console.error('  FAILED: the second read should have come from the cache');
    return 1;
  }

  if (args.exportFormat) {
    const ids = args.exportAll ? candidates.map((c) => c.featureId) : [top.featureId];
    console.log(
      `\n[cli] exporting ${ids.length} feature(s) as ${args.exportFormat} at ` +
        `${args.retention}% retention` +
        (args.exportFormat === 'svg' ? ` in EPSG:${args.srid}` : ''),
    );

    const result = await runExport(
      {
        featureIds: ids,
        format: args.exportFormat,
        retentionPct: args.retention,
        srid: args.srid,
        width: 1920,
        height: 1080,
        padding: 40,
      },
      (p) => {
        if (p.phase !== 'fetching' || p.total > 1) {
          console.log(`      ${p.phase} ${p.done}/${p.total} ${p.message}`);
        }
      },
    );

    console.log(`  wrote ${result.path}`);
    console.log(
      `  ${result.featureCount} feature(s), ${result.verticesBefore} -> ${result.verticesAfter} vertices, ` +
        `${(result.bytes / 1024).toFixed(1)} kB in ${result.elapsedMs}ms`,
    );
    console.log(`  credit: ${result.attribution || '(none)'}`);
    console.log(`  licences: ${result.licences.join(' | ') || '(none)'}`);
    for (const w of result.warnings) console.log(`  WARNING: ${w}`);
  }

  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = join(app.getPath('userData'), 'data', 'catalog.sqlite');
  const db = openDb(dbPath);
  console.log(`[cli] database ${dbPath}`);

  if (args.list) {
    for (const s of db.prepare('SELECT * FROM sources ORDER BY id').all() as SourceRow[]) {
      console.log(
        `  ${String(s.id).padStart(3)}  ${s.tier}  ${s.kind.padEnd(10)} ${s.feature_type.padEnd(30)} ${s.name}`,
      );
    }
    return 0;
  }

  // Direct export of known feature ids, bypassing search. Exists so a multi-feature
  // export -- the topology-sensitive path -- can be driven end to end from a terminal.
  if (args.featureIds.length > 0 && args.exportFormat) {
    console.log(
      `[cli] exporting ${args.featureIds.length} feature(s) as ${args.exportFormat} at ` +
        `${args.retention}% retention` +
        (args.exportFormat === 'svg' ? ` in EPSG:${args.srid}` : ''),
    );
    const result = await runExport(
      {
        featureIds: args.featureIds,
        format: args.exportFormat,
        retentionPct: args.retention,
        srid: args.srid,
        width: 1920,
        height: 1080,
        padding: 40,
      },
      (p) => console.log(`      ${p.phase} ${p.done}/${p.total} ${p.message}`),
    );
    console.log(`  wrote ${result.path}`);
    console.log(
      `  ${result.featureCount} feature(s), ${result.verticesBefore} -> ${result.verticesAfter} vertices, ` +
        `${(result.bytes / 1024).toFixed(1)} kB in ${result.elapsedMs}ms`,
    );
    console.log(`  credit: ${result.attribution || '(none)'}`);
    console.log(`  licences: ${result.licences.join(' | ') || '(none)'}`);
    for (const w of result.warnings) console.log(`  WARNING: ${w}`);
    closeDb();
    return 0;
  }

  if (args.candidates) {
    const rows = db
      .prepare(
        `SELECT title, publisher, kind, feature_type, jurisdiction, live_count, confidence,
                validated, decision, concerns, endpoint, layer_id, name_fields
         FROM discovered_sources ORDER BY decision, confidence DESC, title`,
      )
      .all() as Record<string, unknown>[];

    console.log(`[cli] ${rows.length} discovered candidate(s)\n`);
    for (const r of rows) {
      const concerns = JSON.parse((r['concerns'] as string) || '[]') as string[];
      console.log(
        `  ${Number(r['confidence']).toFixed(2)}  ${r['validated'] ? 'live' : 'DEAD'}  ` +
          `${String(r['decision']).padEnd(8)} ${String(r['title']).slice(0, 62)}`,
      );
      console.log(
        `        ${asText(r['feature_type'], '?')}/${asText(r['jurisdiction'], '?')}  ` +
          `${asText(r['live_count'], '?')} features  fields=${asText(r['name_fields'], '[]')}` +
          `  <- ${asText(r['publisher'], '?')}`,
      );
      console.log(`        ${asText(r['endpoint'], '?')}/${asText(r['layer_id'], '')}`);
      for (const c of concerns) console.log(`        ! ${c}`);
    }
    closeDb();
    return 0;
  }

  if (args.discover.length > 0) {
    const http = new HttpClient({
      log: (level, message) => {
        if (level !== 'debug') console.log(`[http:${level}] ${message}`);
      },
    });

    console.log(`[cli] crawling for: ${args.discover.join(', ')}\n`);
    let lastReport = 0;
    const result = await runDiscovery(
      db,
      http,
      { queries: args.discover, maxPages: 2, maxValidations: args.limit ?? 40, ckanRoots: CKAN_ROOTS },
      {
        onProgress: (p) => {
          const now = Date.now();
          if (p.phase === 'searching' && now - lastReport < 500) return;
          lastReport = now;
          console.log(`    ${p.phase} [${p.catalog}] seen=${p.seen} kept=${p.kept} ${p.message}`);
        },
        log: (level, message) => console.log(`    [${level}] ${message}`),
      },
    );

    console.log(
      `\n[cli] seen ${result.seen}, kept ${result.kept}, already known ${result.duplicates}, ` +
        `validated ${result.validated}, reachable ${result.reachable}, stored ${result.written}`,
    );
    for (const w of result.warnings) console.log(`      WARNING: ${w}`);
    console.log(`\n[cli] review them with --candidates`);
    closeDb();
    return 0;
  }

  if (args.find) {
    return runFind(db, args.find, args.limit ?? 5, args.llm, args);
  }

  const sources = selectSources(db, args);
  if (sources.length === 0) {
    console.error('[cli] no sources selected. Use --list to see the registry, then --id/--type/--name.');
    return 2;
  }

  const http = new HttpClient({
    log: (level, message) => {
      if (level !== 'debug') console.log(`[http:${level}] ${message}`);
    },
  });

  let failures = 0;
  for (const source of sources) {
    console.log(`\n=== ${source.name} (id ${source.id}, ${source.kind}, tier ${source.tier})`);
    setSourceStatus(db, source.id, 'harvesting');
    const started = Date.now();

    try {
      let lastReport = 0;
      const result = await runSource(
        db,
        http,
        source,
        {
          onPhase: (phase, fetched, expected) => {
            const now = Date.now();
            if (phase === 'paging' && now - lastReport < 1000) return;
            lastReport = now;
            console.log(`    ${phase} ${fetched}${expected ? `/${expected}` : ''}`);
          },
          log: (level, message) => console.log(`    [${level}] ${message}`),
        },
        { resume: false, dataDir: dirname(dbPath) },
      );

      for (const w of result.warnings ?? []) console.log(`    WARNING: ${w}`);

      const s = result.stats;
      recordHarvestResult(db, source.id, { featureCount: s.featuresWritten, status: 'ok' });
      console.log(
        `    OK ${s.featuresWritten} features, ${s.aliasesWritten} aliases, ` +
          `${s.featuresMerged} merged, ${s.bboxRejected} bbox rejected in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UnsupportedSourceError) {
        setSourceStatus(db, source.id, 'seeded');
        console.log(`    SKIPPED: ${message}`);
        continue;
      }
      failures++;
      setSourceStatus(db, source.id, 'failed');
      console.error(`    FAILED: ${message}`);
    }
  }

  closeDb();
  return failures === 0 ? 0 : 1;
}

void app.whenReady().then(async () => {
  const code = await main().catch((err: unknown) => {
    console.error('[cli] fatal', err);
    return 1;
  });
  app.exit(code);
});
