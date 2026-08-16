import type { Db } from '@db/index';
import type { SourceRow } from '@shared/types';
import { type HttpClient } from './http';
import * as esri from './catalogs/esri-rest';
import * as wfs from './catalogs/ogc-wfs';
import { createIngestor, type IngestStats } from './ingest';

/**
 * Harvest one source, index-only.
 *
 * The contract that matters: a source is `ok` only if the number of rows we actually
 * paged equals the number the service itself reports. A silently truncated harvest is
 * the worst failure mode in this app, so a mismatch throws.
 */

export interface RunResult {
  stats: IngestStats;
  serviceCount: number;
  rowsFetched: number;
}

/**
 * Raised for a source this milestone cannot harvest yet -- Tier B bulk files (M6) and
 * discovery catalogs (M7). Distinct from a real failure so the UI does not paint a
 * perfectly good source red for not being implemented.
 */
export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}

export interface RunCallbacks {
  onPhase: (phase: 'counting' | 'paging' | 'reconciling', fetched: number, expected: number | null, message: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

function readCheckpoint(db: Db, sourceId: number): { nextOffset: number; fetched: number } {
  const row = db
    .prepare('SELECT next_offset, fetched_count FROM harvest_checkpoints WHERE source_id = ?')
    .get(sourceId) as { next_offset: number; fetched_count: number } | undefined;
  return { nextOffset: row?.next_offset ?? 0, fetched: row?.fetched_count ?? 0 };
}

function writeCheckpoint(db: Db, sourceId: number, nextOffset: number, fetched: number, expected: number | null): void {
  db.prepare(
    `INSERT INTO harvest_checkpoints (source_id, next_offset, expected_count, fetched_count, started_at, updated_at)
     VALUES (@id, @off, @exp, @fetched, @now, @now)
     ON CONFLICT(source_id) DO UPDATE SET
       next_offset = excluded.next_offset,
       expected_count = excluded.expected_count,
       fetched_count = excluded.fetched_count,
       updated_at = excluded.updated_at`,
  ).run({ id: sourceId, off: nextOffset, exp: expected, fetched, now: new Date().toISOString() });
}

export function clearCheckpoint(db: Db, sourceId: number): void {
  db.prepare('DELETE FROM harvest_checkpoints WHERE source_id = ?').run(sourceId);
}

export async function runSource(
  db: Db,
  http: HttpClient,
  source: SourceRow,
  cb: RunCallbacks,
  opts: { resume?: boolean } = {},
): Promise<RunResult> {
  switch (source.kind) {
    case 'esri-rest':
      return runEsri(db, http, source, cb, opts);
    case 'wfs':
      return runWfs(db, http, source, cb, opts);
    case 'bulk-file':
      throw new UnsupportedSourceError(`"${source.name}" is Tier B; bulk ingest arrives in M6.`);
    case 'arcgis-hub':
    case 'ckan':
      throw new UnsupportedSourceError(`"${source.name}" is a discovery catalog; crawlers arrive in M7.`);
    default:
      throw new Error(`Unsupported source kind "${String(source.kind)}" for "${source.name}"`);
  }
}

async function runEsri(
  db: Db,
  http: HttpClient,
  source: SourceRow,
  cb: RunCallbacks,
  opts: { resume?: boolean },
): Promise<RunResult> {
  if (!source.layer_id) throw new Error(`ESRI source "${source.name}" has no layer_id`);
  const nameFields: string[] = source.name_fields ? (JSON.parse(source.name_fields) as string[]) : [];

  cb.onPhase('counting', 0, source.verified_count, 'reading layer metadata');
  const meta = await esri.fetchLayerMeta(http, source.endpoint, source.layer_id);
  cb.log(
    'info',
    `${source.name}: layer "${meta.name}" maxRecordCount=${meta.maxRecordCount} ` +
      `pagination=${meta.supportsPagination} oidField=${meta.objectIdField}`,
  );

  const serviceCount = await esri.fetchCount(http, source.endpoint, source.layer_id);
  cb.log('info', `${source.name}: service reports ${serviceCount} rows`);

  if (source.verified_count !== null && serviceCount !== source.verified_count) {
    cb.log(
      'warn',
      `${source.name}: service count ${serviceCount} differs from the registry's verified ` +
        `${source.verified_count}. The upstream layer has changed since verification.`,
    );
  }

  const outFields = esri.buildOutFields(meta, nameFields);
  cb.log('debug', `${source.name}: outFields=${outFields}`);

  const checkpoint = opts.resume ? readCheckpoint(db, source.id) : { nextOffset: 0, fetched: 0 };
  if (checkpoint.nextOffset > 0) {
    cb.log('info', `${source.name}: resuming from offset ${checkpoint.nextOffset}`);
  }

  const ingestor = createIngestor(db, source);
  let fetched = checkpoint.nextOffset;

  cb.onPhase('paging', fetched, serviceCount, 'paging features');

  for await (const rows of esri.pageFeatures(http, {
    endpoint: source.endpoint,
    layerId: source.layer_id,
    meta,
    outFields,
    startOffset: checkpoint.nextOffset,
  })) {
    ingestor.writeBatch(rows);
    fetched += rows.length;
    writeCheckpoint(db, source.id, fetched, fetched, serviceCount);
    cb.onPhase('paging', fetched, serviceCount, `${fetched}/${serviceCount}`);
  }

  if (http.isCancelled) {
    cb.log('warn', `${source.name}: cancelled at ${fetched}/${serviceCount}; checkpoint kept for resume`);
    return { stats: ingestor.stats, serviceCount, rowsFetched: fetched };
  }

  reconcile(source, fetched, serviceCount, cb);
  clearCheckpoint(db, source.id);
  return { stats: ingestor.stats, serviceCount, rowsFetched: fetched };
}

async function runWfs(
  db: Db,
  http: HttpClient,
  source: SourceRow,
  cb: RunCallbacks,
  opts: { resume?: boolean },
): Promise<RunResult> {
  if (!source.layer_id) throw new Error(`WFS source "${source.name}" has no typeName in layer_id`);
  const nameFields: string[] = source.name_fields ? (JSON.parse(source.name_fields) as string[]) : [];

  cb.onPhase('counting', 0, source.verified_count, 'reading GetCapabilities');
  const meta = await wfs.fetchCapabilities(http, source.endpoint, source.layer_id);

  // Prefer the registry's recorded SRID; fall back to whatever the service advertises.
  const requestSrid = source.source_srid ?? meta.defaultCrsSrid;
  if (!requestSrid) {
    throw new Error(`WFS source "${source.name}" has no source_srid and GetCapabilities advertises none`);
  }
  cb.log('info', `${source.name}: type "${meta.typeName}" requesting EPSG:${requestSrid}`);

  const props = await wfs.describeFeatureType(http, source.endpoint, meta.typeName);
  const sortField = wfs.pickSortField(props);
  const geometryField = wfs.geometryPropertyOf(props);
  const idField = wfs.pickIdField(props);

  // propertyName with a field the type does not have is a 400, so reconcile the registry's
  // declared name fields against the real schema first and say so if they disagree.
  const available = new Set(props.map((p) => p.name));
  const presentNameFields = nameFields.filter((f) => available.has(f));
  if (presentNameFields.length === 0) {
    throw new Error(
      `None of the declared name fields [${nameFields.join(', ')}] exist on WFS type "${meta.typeName}". ` +
        `Available: ${[...available].join(', ')}`,
    );
  }
  if (presentNameFields.length < nameFields.length) {
    const missing = nameFields.filter((f) => !available.has(f));
    cb.log('warn', `${source.name}: declared name fields not present and skipped: ${missing.join(', ')}`);
  }
  cb.log(
    'info',
    `${source.name}: sorting on ${sortField}, identity ${idField ?? 'gml:id'}, ` +
      `geometry property ${geometryField ?? '(none)'}`,
  );

  const serviceCount = await wfs.fetchHits(http, source.endpoint, meta.typeName);
  cb.log('info', `${source.name}: service reports ${serviceCount} features`);

  const checkpoint = opts.resume ? readCheckpoint(db, source.id) : { nextOffset: 0, fetched: 0 };
  const ingestor = createIngestor(db, source);
  let fetched = checkpoint.nextOffset;

  cb.onPhase('paging', fetched, serviceCount, 'paging features');

  for await (const rows of wfs.pageFeatures(http, {
    endpoint: source.endpoint,
    typeName: meta.typeName,
    requestSrid,
    nameFields: presentNameFields,
    sortField,
    geometryField,
    idField,
    startOffset: checkpoint.nextOffset,
  })) {
    ingestor.writeBatch(rows);
    fetched += rows.length;
    writeCheckpoint(db, source.id, fetched, fetched, serviceCount);
    cb.onPhase('paging', fetched, serviceCount, `${fetched}/${serviceCount}`);
  }

  if (http.isCancelled) {
    cb.log('warn', `${source.name}: cancelled at ${fetched}/${serviceCount}; checkpoint kept for resume`);
    return { stats: ingestor.stats, serviceCount, rowsFetched: fetched };
  }

  reconcile(source, fetched, serviceCount, cb);
  clearCheckpoint(db, source.id);
  return { stats: ingestor.stats, serviceCount, rowsFetched: fetched };
}

/**
 * The non-negotiable check. Rows paged must equal rows the service says it has.
 * Merged multipart features are counted separately and are NOT part of this comparison.
 */
function reconcile(source: SourceRow, fetched: number, serviceCount: number, cb: RunCallbacks): void {
  cb.onPhase('reconciling', fetched, serviceCount, 'verifying count');
  if (fetched !== serviceCount) {
    throw new Error(
      `Count mismatch for "${source.name}": paged ${fetched} rows but the service reports ${serviceCount}. ` +
        `Refusing to mark this source complete -- a truncated index would silently return wrong boundaries.`,
    );
  }
  cb.log('info', `${source.name}: reconciled ${fetched} rows against the service count`);
}
