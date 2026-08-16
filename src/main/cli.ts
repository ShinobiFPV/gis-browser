import { join } from 'node:path';
import { app } from 'electron';
import { closeDb, openDb } from '@db/index';
import { recordHarvestResult, setSourceStatus } from '@db/queries';
import type { SourceRow } from '@shared/types';
import { HttpClient } from '../harvester/http';
import { runSource } from '../harvester/run-source';

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
}

function parseArgs(argv: string[]): Args {
  const out: Args = { ids: [], types: [], names: [], list: false, limit: null };
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
      failures++;
      setSourceStatus(db, source.id, 'failed');
      console.error(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
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
