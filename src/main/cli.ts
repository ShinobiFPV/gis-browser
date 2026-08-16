import { join } from 'node:path';
import { app } from 'electron';
import { closeDb, openDb } from '@db/index';
import { recordHarvestResult, setSourceStatus } from '@db/queries';
import type { SourceRow } from '@shared/types';
import { HttpClient } from '../harvester/http';
import { runSource, UnsupportedSourceError } from '../harvester/run-source';
import { resolve as resolveQuery } from '@resolve/resolve';
import { getGeometry } from './geometry-service';

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
}

function parseArgs(argv: string[]): Args {
  const out: Args = { ids: [], types: [], names: [], list: false, limit: null, find: null };
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
    } else if (a === '--list') {
      out.list = true;
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
async function runFind(db: ReturnType<typeof openDb>, text: string, limit: number): Promise<number> {
  const result = resolveQuery(db, text, { limit });
  const { candidates, parsed } = result;

  console.log(`\n[cli] parsed: names=[${parsed.placeNames.join(' | ')}]`);
  console.log(
    `      type=${parsed.featureTypeHint ?? '—'} jurisdiction=${parsed.jurisdictionHint ?? '—'} ` +
      `vintage=${parsed.vintageHint ?? '—'} (${parsed.via})`,
  );
  console.log(`      ${parsed.notes}`);
  for (const n of result.notes) console.log(`      note: ${n}`);
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
      `  ${i + 1}. ${c.matchScore.toFixed(3)}  ${c.officialName}  [${c.featureType}/${c.jurisdiction ?? '—'}]` +
        `  cached=${c.hasCachedGeometry}`,
    );
    console.log(`         via ${c.matchedVia} on "${c.matchedAlias}"  <- ${c.sourceName}`);
    console.log(`         ${c.justification ?? ''}`);
  }

  const top = candidates[0]!;
  console.log(`\n[cli] fetching geometry for "${top.officialName}" (feature ${top.featureId})`);

  const first = await getGeometry(top.featureId);
  console.log(
    `  ${first.fromCache ? 'CACHE' : 'NETWORK'}  ${first.vertexCount.toLocaleString()} vertices, ` +
      `${first.partCount} part(s), ${first.fetchMs}ms`,
  );
  console.log(`  bbox: ${first.bbox ? first.bbox.map((n) => n.toFixed(4)).join(', ') : '(none)'}`);
  console.log(`  attribution: ${first.attribution ?? '(none)'}`);
  console.log(`  geometry type: ${(first.geometry as { type?: string }).type ?? '?'}`);

  const second = await getGeometry(top.featureId);
  console.log(
    `  second read: ${second.fromCache ? 'CACHE' : 'NETWORK'} in ${second.fetchMs}ms ` +
      `(${second.vertexCount.toLocaleString()} vertices)`,
  );
  if (!second.fromCache) {
    console.error('  FAILED: the second read should have come from the cache');
    return 1;
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

  if (args.find) {
    return runFind(db, args.find, args.limit ?? 5);
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
        { resume: false },
      );

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
