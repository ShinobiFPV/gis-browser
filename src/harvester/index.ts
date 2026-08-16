import { openDb } from '@db/index';
import { getSource, recordHarvestResult, setSourceStatus } from '@db/queries';
import type { HarvestProgress } from '@shared/types';
import type { FromHarvester, ToHarvester } from '../main/harvester-host';
import { HttpClient } from './http';
import { runSource } from './run-source';

/**
 * Harvester utilityProcess entry point.
 *
 * Runs outside main and outside the renderer, with its own SQLite connection (WAL makes
 * the UI's concurrent reads safe) and its own HTTP client enforcing the 3-per-host
 * concurrency cap and retry policy. Progress streams back over the message port.
 */

let http: HttpClient | null = null;
let cancelled = false;

function send(msg: FromHarvester): void {
  process.parentPort.postMessage(msg);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, scope: 'harvester', message });
}

function progress(p: HarvestProgress): void {
  send({ type: 'progress', payload: p });
}

process.parentPort.on('message', (e) => {
  const msg = e.data as ToHarvester;
  if (msg.type === 'cancel') {
    cancelled = true;
    http?.cancel();
    log('warn', 'cancellation requested; finishing the current page then stopping');
    return;
  }
  if (msg.type === 'start') {
    void run(msg.dbPath, msg.sourceIds).catch((err: unknown) => {
      log('error', `harvest aborted: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }
});

async function run(dbPath: string, sourceIds: number[]): Promise<void> {
  const db = openDb(dbPath);
  http = new HttpClient({ log: (level, message) => log(level, message) });

  log('info', `harvest starting for ${sourceIds.length} source(s)`);

  for (const id of sourceIds) {
    if (cancelled) break;

    const source = getSource(db, id);
    if (!source) {
      log('error', `source ${id} not found in the registry`);
      continue;
    }

    progress({
      sourceId: id,
      sourceName: source.name,
      phase: 'starting',
      fetched: 0,
      expected: source.verified_count,
      message: `${source.kind} tier ${source.tier}`,
    });
    setSourceStatus(db, id, 'harvesting');

    const started = Date.now();
    try {
      const result = await runSource(
        db,
        http,
        source,
        {
          onPhase: (phase, fetched, expected, message) =>
            progress({ sourceId: id, sourceName: source.name, phase, fetched, expected, message }),
          log,
        },
        { resume: true },
      );

      if (cancelled) {
        setSourceStatus(db, id, 'stale');
        progress({
          sourceId: id,
          sourceName: source.name,
          phase: 'failed',
          fetched: result.rowsFetched,
          expected: result.serviceCount,
          message: 'cancelled',
          error: 'cancelled by user; progress checkpointed for resume',
        });
        break;
      }

      const { stats } = result;
      const features = stats.featuresWritten;
      recordHarvestResult(db, id, { featureCount: features, status: 'ok' });

      const merged = stats.featuresMerged > 0 ? `, ${stats.featuresMerged} multipart rows merged` : '';
      const rejected = stats.bboxRejected > 0 ? `, ${stats.bboxRejected} bbox rejected` : '';
      log(
        'info',
        `${source.name}: ${features} features, ${stats.aliasesWritten} aliases${merged}${rejected} ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      progress({
        sourceId: id,
        sourceName: source.name,
        phase: 'done',
        fetched: result.rowsFetched,
        expected: result.serviceCount,
        message: `${features} features, ${stats.aliasesWritten} aliases`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSourceStatus(db, id, 'failed');
      progress({
        sourceId: id,
        sourceName: source.name,
        phase: 'failed',
        fetched: 0,
        expected: source.verified_count,
        message: 'harvest failed',
        error: message,
      });
      log('error', `${source.name}: ${message}`);
    }
  }

  send({ type: 'finished' });
  log('info', 'harvest finished');
}
