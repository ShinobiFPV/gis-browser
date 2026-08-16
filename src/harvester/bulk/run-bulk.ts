import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@db/index';
import type { SourceRow } from '@shared/types';
import type { HttpClient } from '../http';
import { createIngestor, type IngestStats } from '../ingest';
import { extract, isShapefilePart, listEntries } from './zip';
import {
  decideCrs,
  discoverLayers,
  emptyReadStats,
  readEncoding,
  readLayer,
  selectLayer,
  ShapefileError,
} from './shapefile';

/**
 * Tier B: download a whole archive once, then index it with its geometry.
 *
 * The brief's split. Tier A services can be asked for one boundary at a time, so we index
 * names and fetch geometry on demand. A bulk file has no such interface -- the only way in
 * is to take all of it -- so the download is explicit, user-triggered, cached forever, and
 * the geometry is stored at index time. Those features are then exportable with no network
 * at all, which is the point of having Tier B fallbacks for election night.
 */

export interface BulkPhase {
  phase: 'downloading' | 'extracting' | 'reading' | 'reconciling';
  /** Bytes for downloading, rows for reading. */
  done: number;
  total: number | null;
  message: string;
}

export interface BulkCallbacks {
  onPhase: (p: BulkPhase) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface BulkResult {
  stats: IngestStats;
  rowsRead: number;
  archiveBytes: number;
  sha256: string;
  fromCache: boolean;
  layer: string;
  crsDescription: string;
  warnings: string[];
}

/** Filename for an archive, derived from its URL. */
export function archiveFilename(sourceId: number, url: string): string {
  const tail = url.split('/').pop() ?? 'archive.zip';
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'archive.zip';
  // Prefixed with the source id so two sources publishing the same filename cannot collide.
  return `${sourceId}_${safe}`;
}

function recordDownload(
  db: Db,
  sourceId: number,
  url: string,
  localPath: string,
  bytes: number,
  sha256: string,
): void {
  db.prepare(
    `INSERT INTO bulk_downloads (source_id, url, local_path, bytes, sha256, downloaded_at)
     VALUES (@source_id, @url, @local_path, @bytes, @sha256, @downloaded_at)
     ON CONFLICT(source_id, url) DO UPDATE SET
       local_path    = excluded.local_path,
       bytes         = excluded.bytes,
       sha256        = excluded.sha256,
       downloaded_at = excluded.downloaded_at`,
  ).run({
    source_id: sourceId,
    url,
    local_path: localPath,
    bytes,
    sha256,
    downloaded_at: new Date().toISOString(),
  });
}

export async function runBulk(
  db: Db,
  http: HttpClient,
  source: SourceRow,
  dataDir: string,
  cb: BulkCallbacks,
): Promise<BulkResult> {
  const warnings: string[] = [];

  const downloadDir = join(dataDir, 'bulk');
  const workDir = join(dataDir, 'bulk', `extract-${source.id}`);
  mkdirSync(downloadDir, { recursive: true });

  // --- download ------------------------------------------------------------------
  const archivePath = join(downloadDir, archiveFilename(source.id, source.endpoint));

  cb.onPhase({ phase: 'downloading', done: 0, total: null, message: 'starting download' });
  const download = await http.downloadToFile(source.endpoint, archivePath, {
    onProgress: ({ receivedBytes, totalBytes }) => {
      cb.onPhase({
        phase: 'downloading',
        done: receivedBytes,
        total: totalBytes,
        message: totalBytes
          ? `${(receivedBytes / 1e6).toFixed(1)} of ${(totalBytes / 1e6).toFixed(1)} MB`
          : `${(receivedBytes / 1e6).toFixed(1)} MB`,
      });
    },
  });

  cb.log(
    'info',
    `${source.name}: ${download.fromCache ? 'using cached archive' : 'downloaded'} ` +
      `${(download.bytes / 1e6).toFixed(1)} MB sha256=${download.sha256.slice(0, 12)}…`,
  );
  recordDownload(db, source.id, source.endpoint, archivePath, download.bytes, download.sha256);

  // --- extract -------------------------------------------------------------------
  const entries = await listEntries(archivePath);
  const wanted = entries.filter((e) => !e.isDirectory && isShapefilePart(e.name));
  if (wanted.length === 0) {
    throw new ShapefileError(
      `The archive for "${source.name}" contains no shapefile (${entries.length} entries, ` +
        `none ending in .shp/.dbf/.prj). Contents: ${entries.slice(0, 8).map((e) => e.name).join(', ')}`,
    );
  }

  const uncompressed = wanted.reduce((n, e) => n + e.uncompressedBytes, 0);
  cb.log(
    'info',
    `${source.name}: extracting ${wanted.length} of ${entries.length} entries ` +
      `(${(uncompressed / 1e6).toFixed(1)} MB uncompressed; skipping metadata)`,
  );

  // A previous interrupted run may have left a partial extraction behind.
  rmSync(workDir, { recursive: true, force: true });

  cb.onPhase({ phase: 'extracting', done: 0, total: uncompressed, message: 'extracting' });
  const extracted = await extract(archivePath, workDir, isShapefilePart, (bytesWritten) => {
    cb.onPhase({
      phase: 'extracting',
      done: bytesWritten,
      total: uncompressed,
      message: `${(bytesWritten / 1e6).toFixed(1)} of ${(uncompressed / 1e6).toFixed(1)} MB`,
    });
  });

  try {
    // --- read --------------------------------------------------------------------
    const layers = discoverLayers(extracted.files);
    const set = selectLayer(layers, source.layer_id, source.name);
    if (layers.length > 1) {
      cb.log('info', `${source.name}: ${layers.length} layers present; indexing "${set.layer}"`);
    }

    const { encoding, declared } = readEncoding(set.cpg);
    if (!declared) {
      warnings.push(
        `"${source.name}" ships no .cpg, so the attribute encoding is undeclared. Reading as UTF-8; ` +
          `accented names may be wrong if the file is actually Latin-1.`,
      );
    }
    cb.log('info', `${source.name}: attribute encoding ${encoding}${declared ? ' (from .cpg)' : ' (assumed)'}`);

    // A point near the middle of the data, so the CRS comparison is meaningful rather
    // than a test of behaviour at the projection's far edge.
    const sample = sampleCoordinate(set.shp);
    const crs = decideCrs(set.prj, source.source_srid, sample, source.name);
    if (crs.disagreement) {
      warnings.push(crs.disagreement);
      cb.log('warn', crs.disagreement);
    }
    cb.log('info', `${source.name}: reading "${set.layer}" as ${crs.description}`);

    const ingestor = createIngestor(db, source, { namelessRows: 'skip', bboxPolicy: 'intersects' });
    const readStats = emptyReadStats();
    // Every row ingest touches gets retrieved_at = now, so anything still carrying an
    // older stamp when the file has been read end to end was not in it. See the sweep below.
    const runStartedAt = new Date().toISOString();
    let rowsRead = 0;

    cb.onPhase({ phase: 'reading', done: 0, total: source.verified_count, message: 'indexing features' });

    for await (const batch of readLayer({
      set,
      crs,
      encoding,
      stats: readStats,
      onProgress: (n) => {
        cb.onPhase({
          phase: 'reading',
          done: n,
          total: source.verified_count,
          message: `${n} features`,
        });
      },
      isCancelled: () => http.isCancelled,
    })) {
      ingestor.writeBatch(batch);
      rowsRead += batch.length;
    }

    if (readStats.skippedOutsideCanada > 0) {
      cb.log(
        'info',
        `${source.name}: kept ${rowsRead} of ${readStats.recordsSeen} records; ` +
          `${readStats.skippedOutsideCanada} lie entirely outside Canada`,
      );
    }
    if (readStats.droppedDistantParts > 0) {
      warnings.push(
        `"${source.name}" is a world dataset: ${readStats.droppedDistantParts} outlying part(s) of ` +
          `otherwise-relevant features were dropped (Hawaii and American Samoa from the United ` +
          `States, for instance). Their bounding boxes would otherwise span the globe and match ` +
          `every spatial search.`,
      );
      cb.log('info', warnings[warnings.length - 1]!);
    }
    if (readStats.skippedNullGeometry > 0) {
      warnings.push(
        `"${source.name}" had ${readStats.skippedNullGeometry} record(s) with no geometry. ` +
          `They are in the file but cannot be exported, so they were not indexed.`,
      );
    }

    /*
     * Rows that reached ingest and came out with a name.
     *
     * Counted as rowsRead minus the nameless ones, NOT from stats.featuresWritten: that
     * field counts new INSERTs, so on a re-harvest -- where every feature already exists
     * and is updated instead -- it is zero. Gating on it made the second harvest of any
     * bulk source fail with "every record was nameless".
     */
    const named = rowsRead - ingestor.stats.skippedNameless;
    if (ingestor.stats.skippedNameless > 0) {
      // Every row nameless means the registry's name_fields do not match the file, not
      // that the publisher shipped an unnamed dataset.
      if (named === 0) {
        throw new ShapefileError(
          `Every one of the ${ingestor.stats.skippedNameless} records in "${set.layer}" was ` +
            `nameless. The registry declares name fields [${source.name_fields ?? '[]'}], which ` +
            `this archive does not appear to have.`,
        );
      }
      cb.log(
        'info',
        `${source.name}: ${ingestor.stats.skippedNameless} record(s) carry no name in ` +
          `[${source.name_fields ?? ''}] and were skipped; they cannot be searched for`,
      );
    }

    // Every record falling outside Canada is the signature of a CRS blunder, not a
    // dataset that happens to be foreign -- a whole layer landing in the wrong hemisphere
    // looks exactly like this. Worth its own message, because "0 features" alone sends
    // you looking at the archive rather than at the projection.
    if (rowsRead === 0 && readStats.skippedOutsideCanada === readStats.recordsSeen && readStats.recordsSeen > 0) {
      throw new ShapefileError(
        `All ${readStats.recordsSeen} records of "${source.name}" reprojected to somewhere ` +
          `outside Canada. The archive was read as ${crs.description}, which is almost ` +
          `certainly the wrong CRS for it.`,
      );
    }

    if (http.isCancelled) {
      cb.log('warn', `${source.name}: cancelled after ${rowsRead} features`);
      return {
        stats: ingestor.stats,
        rowsRead,
        archiveBytes: download.bytes,
        sha256: download.sha256,
        fromCache: download.fromCache,
        layer: set.layer,
        crsDescription: crs.description,
        warnings,
      };
    }

    // --- reconcile ---------------------------------------------------------------
    cb.onPhase({ phase: 'reconciling', done: rowsRead, total: source.verified_count, message: 'verifying count' });

    if (source.verified_count !== null && rowsRead !== source.verified_count) {
      // Unlike Tier A there is no service count to compare against -- the file is the
      // only authority. A difference from the registry means the publisher reissued the
      // dataset, which is worth saying but is not corruption.
      warnings.push(
        `"${source.name}" contains ${rowsRead} features but the registry recorded ` +
          `${source.verified_count} at verification. The publisher has reissued this dataset.`,
      );
      cb.log('warn', warnings[warnings.length - 1]!);
    }

    if (rowsRead === 0) {
      throw new ShapefileError(
        `"${source.name}" yielded no features. The archive downloaded and extracted, but ` +
          `"${set.layer}" is empty or every record had null geometry.`,
      );
    }

    /*
     * Remove features this source produced before but not now.
     *
     * A bulk harvest reads the entire file in one pass, so once it completes uninterrupted
     * the set of rows written IS the dataset -- anything left over is stale. That happens
     * for real: tightening the world-dataset filter dropped Russia from the countries
     * layer, and without this sweep its 214-part, globe-spanning geometry would have sat
     * in the catalog forever, matching every bbox search.
     *
     * Deliberately not done for Tier A, where a harvest is paged and resumable and a
     * cancelled run would delete everything it had not got to yet. Guarded on the same
     * condition here: the sweep is skipped entirely if the read was cancelled.
     */
    const swept = db
      .prepare('DELETE FROM features WHERE source_id = ? AND retrieved_at < ?')
      .run(source.id, runStartedAt);
    if (swept.changes > 0) {
      cb.log(
        'info',
        `${source.name}: removed ${swept.changes} feature(s) that this archive no longer contains`,
      );
    }

    return {
      stats: ingestor.stats,
      rowsRead,
      archiveBytes: download.bytes,
      sha256: download.sha256,
      fromCache: download.fromCache,
      layer: set.layer,
      crsDescription: crs.description,
      warnings,
    };
  } finally {
    // The archive is kept -- it is the expensive part and the whole point of caching it.
    // The extraction is not: it is several times larger and reproducible in seconds.
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * A representative coordinate from the shapefile header bbox, used only to compare CRS
 * definitions against each other.
 */
function sampleCoordinate(shpPath: string): [number, number] {
  // The .shp header holds the bbox at bytes 36..68 as little-endian doubles.
  const fd = openSync(shpPath, 'r');
  try {
    const header = Buffer.alloc(100);
    readSync(fd, header, 0, 100, 0);
    const minX = header.readDoubleLE(36);
    const minY = header.readDoubleLE(44);
    const maxX = header.readDoubleLE(52);
    const maxY = header.readDoubleLE(60);
    if ([minX, minY, maxX, maxY].every((n) => Number.isFinite(n))) {
      return [(minX + maxX) / 2, (minY + maxY) / 2];
    }
    return [0, 0];
  } finally {
    closeSync(fd);
  }
}

export function archiveSizeOnDisk(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
