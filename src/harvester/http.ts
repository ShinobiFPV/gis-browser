import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The only way this app talks to the network.
 *
 * Rules, all enforced here rather than at each call site:
 *   - every request has a timeout
 *   - every request has a retry policy (429 / 5xx / transport errors only)
 *   - at most 3 concurrent requests per host
 *   - every request emits a log line
 *   - a failure throws with the HTTP status and the full URL, never a bare message
 *
 * There is no mock mode and no silent fallback. If a service is down, the harvest
 * fails and says which URL failed.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyExcerpt: string,
    readonly attempts: number,
  ) {
    super(`HTTP ${status} after ${attempts} attempt(s) for ${url}${bodyExcerpt ? ` -- ${bodyExcerpt}` : ''}`);
    this.name = 'HttpError';
  }
}

/**
 * ESRI and GeoServer both answer errors with HTTP 200 and an error object in the body.
 * A harvest that treats those as success is exactly the silent-truncation failure mode
 * we cannot ship, so they get their own error type and are never retried blindly.
 */
export class ServiceError extends Error {
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(`Service returned an error payload for ${url} -- ${detail}`);
    this.name = 'ServiceError';
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  /** Requests in flight per host. The brief caps this at 3; do not raise it casually. */
  concurrencyPerHost?: number;
  userAgent?: string;
  log?: Logger;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Pulls the useful sentence out of an error body. OGC servers bury the actual reason
 * inside <ows:ExceptionText> after 300 characters of XML schema boilerplate, and a blind
 * truncation throws away the only part worth reading.
 */
export function excerptError(body: string): string {
  const ows = /<ows:ExceptionText>([\s\S]*?)<\/ows:ExceptionText>/.exec(body);
  const text = ows?.[1] ?? body;
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal FIFO semaphore. One instance per host. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly concurrencyPerHost: number;
  private readonly userAgent: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly hostLimits = new Map<string, Semaphore>();

  private cancelled = false;

  constructor(opts: HttpOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.concurrencyPerHost = opts.concurrencyPerHost ?? 3;
    this.userAgent = opts.userAgent ?? 'GIS-Browser/0.1 (+ShinTech; boundary harvester)';
    this.log = opts.log ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleepImpl ?? defaultSleep;
  }

  /** Makes every in-flight and queued request give up at the next checkpoint. */
  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  private limiterFor(url: string): Semaphore {
    const host = new URL(url).host;
    let s = this.hostLimits.get(host);
    if (!s) {
      s = new Semaphore(this.concurrencyPerHost);
      this.hostLimits.set(host, s);
    }
    return s;
  }

  async getText(url: string): Promise<string> {
    const limiter = this.limiterFor(url);
    await limiter.acquire();
    try {
      return await this.attemptLoop(url);
    } finally {
      limiter.release();
    }
  }

  async getJson<T = unknown>(url: string): Promise<T> {
    const text = await this.getText(url);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServiceError(url, `response was not JSON: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  }

  private async attemptLoop(url: string): Promise<string> {
    let lastStatus = 0;
    let lastBody = '';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.cancelled) throw new Error(`cancelled before completing ${url}`);

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json, text/xml, */*' },
        });
        const ms = Date.now() - started;

        if (res.ok) {
          const body = await res.text();
          this.log('debug', `GET ${res.status} ${ms}ms ${body.length}B ${url}`);
          return body;
        }

        lastStatus = res.status;
        lastBody = excerptError(await res.text().catch(() => ''));
        this.log('warn', `GET ${res.status} ${ms}ms ${url}`);

        if (!RETRYABLE_STATUS.has(res.status) || attempt === this.maxAttempts) {
          throw new HttpError(res.status, url, lastBody, attempt);
        }

        await this.sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
      } catch (err) {
        clearTimeout(timer);

        // A thrown HttpError is our own decision not to retry -- propagate it.
        if (err instanceof HttpError) throw err;

        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof Error && err.name === 'AbortError';
        this.log('warn', `GET ${aborted ? `timeout after ${this.timeoutMs}ms` : `transport error: ${message}`} ${url}`);

        if (attempt === this.maxAttempts) {
          throw new HttpError(0, url, aborted ? `timed out after ${this.timeoutMs}ms` : message, attempt);
        }
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new HttpError(lastStatus, url, lastBody, this.maxAttempts);
  }

  /**
   * Streams a URL to disk, for Tier B bulk archives.
   *
   * Separate from attemptLoop because the assumptions are different in three ways:
   *
   *   - The body never enters memory. StatCan's dissemination-area archive is 188 MB
   *     compressed, and buffering it as a string would be both slow and pointless.
   *   - The timeout is a STALL timeout, reset on every chunk, not a total one. A 188 MB
   *     download legitimately takes longer than the 60s a single API call gets.
   *   - Retries resume from what is already on disk with a Range request rather than
   *     starting over, so a connection dropped at 180 MB does not cost 180 MB again.
   *
   * There is deliberately no HEAD probe first. www12.statcan.gc.ca answers HEAD with an
   * infinite redirect chain ("redirect count exceeded") while serving GET perfectly well,
   * so asking for the size separately breaks two of the seven bulk sources.
   */
  async downloadToFile(
    url: string,
    destPath: string,
    opts: {
      onProgress?: (p: { receivedBytes: number; totalBytes: number | null }) => void;
      stallTimeoutMs?: number;
      /** Reuse an already-downloaded file when its size matches. */
      expectedBytes?: number | null;
    } = {},
  ): Promise<{ path: string; bytes: number; sha256: string; resumed: boolean; elapsedMs: number; fromCache: boolean }> {
    const stallTimeoutMs = opts.stallTimeoutMs ?? 120_000;
    const partPath = `${destPath}.part`;
    const started = Date.now();

    if (existsSync(destPath)) {
      const bytes = statSync(destPath).size;
      // A truncated leftover is worse than no file: it would be unzipped into a partial
      // dataset. Only trust it when the size matches what the registry expects, or when
      // the registry has no expectation and the file is non-empty.
      if (bytes > 0 && (opts.expectedBytes == null || bytes === opts.expectedBytes)) {
        this.log('info', `reusing cached download ${destPath} (${bytes} bytes)`);
        return {
          path: destPath,
          bytes,
          sha256: await sha256File(destPath),
          resumed: false,
          elapsedMs: Date.now() - started,
          fromCache: true,
        };
      }
      this.log('warn', `discarding cached ${destPath}: ${bytes} bytes, expected ${String(opts.expectedBytes)}`);
      unlinkSync(destPath);
    }

    const limiter = this.limiterFor(url);
    await limiter.acquire();

    try {
      let resumed = false;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (this.cancelled) throw new Error(`cancelled before completing ${url}`);

        const already = existsSync(partPath) ? statSync(partPath).size : 0;
        const controller = new AbortController();

        // Reset on every chunk, so a slow-but-alive transfer is never killed.
        let stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
        const touch = (): void => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
        };

        try {
          const headers: Record<string, string> = {
            'User-Agent': this.userAgent,
            Accept: 'application/zip, application/octet-stream, */*',
          };
          if (already > 0) headers['Range'] = `bytes=${already}-`;

          const res = await this.fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers });

          if (!res.ok) {
            const body = excerptError(await res.text().catch(() => ''));
            this.log('warn', `GET ${res.status} ${url}`);
            if (!RETRYABLE_STATUS.has(res.status) || attempt === this.maxAttempts) {
              throw new HttpError(res.status, url, body, attempt);
            }
            await this.sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
            continue;
          }

          // 206 means the server honoured the Range and we append. 200 means it ignored
          // the Range and is sending the whole file, so the partial must be discarded --
          // appending to it would produce a corrupt archive that still unzips far enough
          // to look plausible.
          const appending = already > 0 && res.status === 206;
          if (already > 0 && !appending) {
            this.log('warn', `${url} ignored the Range request; restarting the download`);
            unlinkSync(partPath);
          }
          if (appending) {
            resumed = true;
            this.log('info', `resuming ${url} at ${already} bytes`);
          }

          const contentLength = res.headers.get('content-length');
          const totalBytes = contentLength
            ? Number(contentLength) + (appending ? already : 0)
            : (opts.expectedBytes ?? null);

          if (!res.body) throw new HttpError(0, url, 'response had no body', attempt);

          let received = appending ? already : 0;
          const source = Readable.fromWeb(res.body);
          source.on('data', (chunk: Buffer) => {
            received += chunk.length;
            touch();
            opts.onProgress?.({ receivedBytes: received, totalBytes });
            if (this.cancelled) source.destroy(new Error(`cancelled while downloading ${url}`));
          });

          await pipeline(source, createWriteStream(partPath, { flags: appending ? 'a' : 'w' }));
          clearTimeout(stallTimer);

          const bytes = statSync(partPath).size;
          if (totalBytes !== null && bytes !== totalBytes) {
            throw new HttpError(
              0,
              url,
              `download ended at ${bytes} bytes but ${totalBytes} were expected`,
              attempt,
            );
          }

          renameSync(partPath, destPath);
          const elapsedMs = Date.now() - started;
          this.log(
            'info',
            `downloaded ${bytes} bytes in ${elapsedMs}ms (${((bytes / 1e6 / (elapsedMs / 1000)) || 0).toFixed(1)} MB/s) ${url}`,
          );

          return {
            path: destPath,
            bytes,
            sha256: await sha256File(destPath),
            resumed,
            elapsedMs,
            fromCache: false,
          };
        } catch (err) {
          clearTimeout(stallTimer);
          if (err instanceof HttpError) throw err;
          if (this.cancelled) throw err instanceof Error ? err : new Error(String(err));

          const message = err instanceof Error ? err.message : String(err);
          const aborted = err instanceof Error && err.name === 'AbortError';
          this.log(
            'warn',
            `GET ${aborted ? `stalled for ${stallTimeoutMs}ms` : `transport error: ${message}`} ${url}`,
          );
          if (attempt === this.maxAttempts) {
            throw new HttpError(0, url, aborted ? `stalled for ${stallTimeoutMs}ms` : message, attempt);
          }
          await this.sleep(this.backoffMs(attempt, null));
        }
      }

      throw new HttpError(0, url, 'download did not complete', this.maxAttempts);
    } finally {
      limiter.release();
    }
  }

  /** Exponential with full jitter, and Retry-After wins when the server sends one. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    }
    const base = Math.min(500 * 2 ** (attempt - 1), 20_000);
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }
}

/**
 * Hashes a finished file in one streaming pass.
 *
 * Done after the download rather than incrementally during it, because a resumed download
 * would otherwise need the hash state from the interrupted process. Re-reading 188 MB from
 * local disk costs about a second; carrying partial hash state across restarts would be a
 * source of silent corruption.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Builds a query string without the encodeURIComponent noise at every call site. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}
