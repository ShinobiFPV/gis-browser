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

/** Builds a query string without the encodeURIComponent noise at every call site. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}
