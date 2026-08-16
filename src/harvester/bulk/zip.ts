import { createWriteStream, mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

/**
 * Zip reading for Tier B archives.
 *
 * Pure JS via yauzl -- no system unzip, per the brief's one-installer constraint.
 *
 * Two things this does that a naive extractor does not:
 *
 *   - Refuses entries that would escape the target directory. A zip entry name is
 *     attacker-controlled data even when it comes from a government FTP server, and
 *     "../../../etc/passwd" or "C:\Windows\..." must never be written. This is the
 *     zip-slip class of bug and it is trivially avoidable.
 *   - Extracts selectively. The Aboriginal Lands archive carries 620 kB of ISO metadata
 *     HTML and XML beside the shapefile; there is no reason to write it to disk.
 */

export interface ZipEntry {
  /** Path as recorded in the archive, always with forward slashes. */
  name: string;
  uncompressedBytes: number;
  isDirectory: boolean;
}

export class UnsafeZipEntryError extends Error {
  constructor(entryName: string) {
    super(
      `Refusing to extract "${entryName}": the entry resolves outside the target directory. ` +
        `This archive is malformed or hostile.`,
    );
    this.name = 'UnsafeZipEntryError';
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error(`Could not open ${path} as a zip archive`));
      else resolvePromise(zip);
    });
  });
}

export async function listEntries(zipPath: string): Promise<ZipEntry[]> {
  const zip = await openZip(zipPath);
  return new Promise((resolvePromise, reject) => {
    const entries: ZipEntry[] = [];
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push({
        name: entry.fileName,
        uncompressedBytes: entry.uncompressedSize,
        isDirectory: /\/$/.test(entry.fileName),
      });
      zip.readEntry();
    });
    zip.on('end', () => resolvePromise(entries));
    zip.on('error', reject);
  });
}

/**
 * Resolves an entry name inside a target directory, or throws.
 *
 * Exported so the rule is testable on its own -- the failure it prevents is one you can
 * only otherwise observe by actually writing outside the directory.
 */
export function safeJoin(targetDir: string, entryName: string): string {
  // Zip stores forward slashes regardless of platform. Backslashes in a name are not a
  // path separator per the spec, but Windows will treat them as one, so normalise first.
  const cleaned = entryName.replace(/\\/g, '/');
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new UnsafeZipEntryError(entryName);

  const base = resolve(targetDir);
  const full = resolve(base, normalize(cleaned));
  const rel = relative(base, full);

  // Empty means the entry IS the target directory; absolute means it escaped entirely.
  if (rel === '' || isAbsolute(rel)) throw new UnsafeZipEntryError(entryName);

  // Traversal is tested per path SEGMENT, not with startsWith('..'): a file legitimately
  // named "..leading.shp" begins with two dots without climbing anywhere, and rejecting it
  // would refuse a valid archive.
  if (rel.split(sep).includes('..')) throw new UnsafeZipEntryError(entryName);

  return full;
}

export interface ExtractResult {
  /** Absolute paths written, in archive order. */
  files: string[];
  bytesWritten: number;
  skipped: number;
}

/**
 * Extracts entries matching `keep` into targetDir.
 *
 * `keep` receives the entry name; returning false skips it without writing anything.
 */
export async function extract(
  zipPath: string,
  targetDir: string,
  keep: (name: string) => boolean = () => true,
  onProgress?: (bytesWritten: number) => void,
): Promise<ExtractResult> {
  mkdirSync(targetDir, { recursive: true });
  const zip = await openZip(zipPath);

  return new Promise((resolvePromise, reject) => {
    const files: string[] = [];
    let bytesWritten = 0;
    let skipped = 0;

    zip.readEntry();

    zip.on('entry', (entry: yauzl.Entry) => {
      if (/\/$/.test(entry.fileName)) {
        zip.readEntry();
        return;
      }
      if (!keep(entry.fileName)) {
        skipped++;
        zip.readEntry();
        return;
      }

      let dest: string;
      try {
        dest = safeJoin(targetDir, entry.fileName);
      } catch (err) {
        zip.close();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      mkdirSync(join(dest, '..'), { recursive: true });

      zip.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          zip.close();
          reject(err ?? new Error(`Could not read "${entry.fileName}" from ${zipPath}`));
          return;
        }
        pipeline(readStream, createWriteStream(dest))
          .then(() => {
            files.push(dest);
            bytesWritten += entry.uncompressedSize;
            onProgress?.(bytesWritten);
            zip.readEntry();
          })
          .catch((pipeErr: unknown) => {
            zip.close();
            reject(pipeErr instanceof Error ? pipeErr : new Error(String(pipeErr)));
          });
      });
    });

    zip.on('end', () => resolvePromise({ files, bytesWritten, skipped }));
    zip.on('error', reject);
  });
}

/** The sidecars a shapefile actually needs, plus the two that describe how to read it. */
export const SHAPEFILE_EXTENSIONS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'];

export function isShapefilePart(name: string): boolean {
  const lower = name.toLowerCase();
  // .shp.xml is ESRI metadata, not geometry, and would otherwise match ".shp".
  if (lower.endsWith('.shp.xml')) return false;
  return SHAPEFILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
