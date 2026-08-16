import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from './http';

/**
 * The Tier B download path, exercised without a network.
 *
 * These cover the failure modes that cost real bytes: a connection dropped part-way
 * through a 188 MB archive, and a server that ignores Range and starts over.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gisb-dl-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BODY = 'abcdefghijklmnopqrstuvwxyz';

function bodyStream(text: string): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8');
  return new ReadableStream({
    start(controller) {
      // Two chunks, so the progress callback and the stall-timer reset both run.
      controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
      controller.enqueue(bytes.subarray(Math.ceil(bytes.length / 2)));
      controller.close();
    },
  });
}

interface Call {
  url: string;
  range: string | null;
}

/** A fetch that honours Range, records calls, and can be told to fail the first N times. */
function fakeFetch(
  calls: Call[],
  opts: { honourRange?: boolean; failFirst?: number; body?: string } = {},
): typeof fetch {
  const body = opts.body ?? BODY;
  let failures = 0;

  return ((url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.['Range'] ?? null;
    calls.push({ url, range });

    if (opts.failFirst && failures < opts.failFirst) {
      failures++;
      return Promise.reject(new Error('socket hang up'));
    }

    const start = range && opts.honourRange !== false ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = body.slice(start);

    return Promise.resolve({
      ok: true,
      status: start > 0 && opts.honourRange !== false ? 206 : 200,
      headers: new Headers({ 'content-length': String(Buffer.byteLength(slice)) }),
      body: bodyStream(slice),
      text: () => Promise.resolve(''),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({ fetchImpl, sleepImpl: () => Promise.resolve(), maxAttempts: 3 });
}

describe('downloadToFile', () => {
  it('writes the whole body and reports its size and hash', async () => {
    const calls: Call[] = [];
    const dest = join(dir, 'a.zip');
    const result = await client(fakeFetch(calls)).downloadToFile('https://example.test/a.zip', dest);

    expect(readFileSync(dest, 'utf8')).toBe(BODY);
    expect(result.bytes).toBe(BODY.length);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fromCache).toBe(false);
    expect(result.resumed).toBe(false);
  });

  it('never sends a HEAD request', async () => {
    // www12.statcan.gc.ca answers HEAD with an infinite redirect chain while serving GET
    // perfectly. Probing for the size separately breaks two of the seven bulk sources.
    const calls: Call[] = [];
    const seen: string[] = [];
    const recordingFetch = ((url: string, init?: RequestInit) => {
      seen.push(init?.method ?? 'GET');
      return fakeFetch(calls)(url, init);
    }) as unknown as typeof fetch;

    await client(recordingFetch).downloadToFile('https://example.test/a.zip', join(dir, 'a.zip'));
    expect(seen).not.toContain('HEAD');
  });

  it('leaves no .part file behind on success', async () => {
    const dest = join(dir, 'a.zip');
    await client(fakeFetch([])).downloadToFile('https://example.test/a.zip', dest);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('resumes from a partial file with a Range request', async () => {
    const dest = join(dir, 'a.zip');
    writeFileSync(`${dest}.part`, BODY.slice(0, 10), 'utf8');

    const calls: Call[] = [];
    const result = await client(fakeFetch(calls)).downloadToFile('https://example.test/a.zip', dest);

    expect(calls[0]?.range).toBe('bytes=10-');
    expect(result.resumed).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
  });

  it('discards the partial file when the server ignores Range', async () => {
    // Appending a full body to a partial one produces a corrupt archive that still unzips
    // far enough to look plausible, which is the worst possible outcome.
    const dest = join(dir, 'a.zip');
    writeFileSync(`${dest}.part`, BODY.slice(0, 10), 'utf8');

    const calls: Call[] = [];
    const result = await client(fakeFetch(calls, { honourRange: false })).downloadToFile(
      'https://example.test/a.zip',
      dest,
    );

    expect(calls[0]?.range).toBe('bytes=10-');
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
    expect(result.bytes).toBe(BODY.length);
  });

  it('retries a dropped connection and resumes rather than restarting', async () => {
    const dest = join(dir, 'a.zip');
    writeFileSync(`${dest}.part`, BODY.slice(0, 10), 'utf8');

    const calls: Call[] = [];
    await client(fakeFetch(calls, { failFirst: 1 })).downloadToFile('https://example.test/a.zip', dest);

    expect(calls).toHaveLength(2);
    // Both attempts asked to continue from byte 10; neither started over.
    expect(calls[0]?.range).toBe('bytes=10-');
    expect(calls[1]?.range).toBe('bytes=10-');
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
  });

  it('gives up with the URL and attempt count after exhausting retries', async () => {
    const alwaysFails = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    await expect(
      client(alwaysFails).downloadToFile('https://example.test/a.zip', join(dir, 'a.zip')),
    ).rejects.toThrow(HttpError);
  });

  it('reuses a cached file when its size matches what the registry expects', async () => {
    const dest = join(dir, 'a.zip');
    writeFileSync(dest, BODY, 'utf8');

    const calls: Call[] = [];
    const result = await client(fakeFetch(calls)).downloadToFile('https://example.test/a.zip', dest, {
      expectedBytes: BODY.length,
    });

    expect(calls).toHaveLength(0);
    expect(result.fromCache).toBe(true);
    expect(result.bytes).toBe(BODY.length);
  });

  it('re-downloads a cached file whose size does not match', async () => {
    const dest = join(dir, 'a.zip');
    writeFileSync(dest, 'truncated', 'utf8');

    const calls: Call[] = [];
    const result = await client(fakeFetch(calls)).downloadToFile('https://example.test/a.zip', dest, {
      expectedBytes: BODY.length,
    });

    expect(calls).toHaveLength(1);
    expect(result.fromCache).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
  });

  it('reports progress as bytes arrive', async () => {
    const seen: { receivedBytes: number; totalBytes: number | null }[] = [];
    await client(fakeFetch([])).downloadToFile('https://example.test/a.zip', join(dir, 'a.zip'), {
      onProgress: (p) => seen.push(p),
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]?.receivedBytes).toBe(BODY.length);
    expect(seen[seen.length - 1]?.totalBytes).toBe(BODY.length);
  });

  it('rejects a truncated transfer rather than treating it as complete', async () => {
    // A body shorter than content-length means the connection died mid-stream. Renaming
    // that to .zip would cache a corrupt archive permanently.
    const shortFetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '999' }),
        body: bodyStream(BODY),
        text: () => Promise.resolve(''),
      } as unknown as Response)) as unknown as typeof fetch;

    await expect(
      client(shortFetch).downloadToFile('https://example.test/a.zip', join(dir, 'a.zip')),
    ).rejects.toThrow(/ended at 26 bytes but 999 were expected/);
  });
});
