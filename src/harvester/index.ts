import { openDb } from '@db/index';
import { getSource, setSourceStatus } from '@db/queries';
import type { HarvestProgress } from '@shared/types';
import type { FromHarvester, ToHarvester } from '../main/harvester-host';

/**
 * Harvester utilityProcess entry point.
 *
 * Runs outside main and outside the renderer. Opens its own connection to the same
 * SQLite file (WAL mode makes concurrent reads from the UI safe) and streams progress
 * back over the message port.
 *
 * M0 wires the process, the message protocol and the checkpoint bookkeeping.
 * M1 plugs the ESRI REST and WFS catalog clients into runSource().
 */

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
    log('warn', 'cancellation requested');
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
      expected: source.verified_count ?? null,
      message: `${source.kind} tier ${source.tier}`,
    });

    setSourceStatus(db, id, 'harvesting');

    try {
      await runSource();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSourceStatus(db, id, 'failed');
      progress({
        sourceId: id,
        sourceName: source.name,
        phase: 'failed',
        fetched: 0,
        expected: source.verified_count ?? null,
        message: 'harvest failed',
        error: message,
      });
      log('error', `${source.name}: ${message}`);
      continue;
    }

    progress({
      sourceId: id,
      sourceName: source.name,
      phase: 'done',
      fetched: 0,
      expected: source.verified_count ?? null,
      message: 'not implemented until M1',
    });
    setSourceStatus(db, id, 'seeded');
  }

  send({ type: 'finished' });
  log('info', 'harvest finished');
}

/**
 * M1 replaces this with a dispatch on source.kind into the catalog clients:
 * esri-rest and wfs index attributes only (returnGeometry=false / propertyName), page
 * to exhaustion, then reconcile the row count against the service's own count and throw
 * on mismatch rather than accepting a truncated harvest.
 */
async function runSource(): Promise<void> {
  throw new Error('catalog clients are not implemented until M1');
}
