import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * Anthropic API key storage.
 *
 * The key is encrypted with Electron's safeStorage (DPAPI on Windows) and written to a
 * file beside the app data -- deliberately NOT into the SQLite catalog, which the user
 * may copy around or hand to someone else. It is never sent to the renderer, never
 * logged, and only ever read inside main at the moment a request is built.
 */

function keyPath(): string {
  return join(app.getPath('userData'), 'anthropic.key');
}

export function hasKey(): boolean {
  return existsSync(keyPath());
}

export function setKey(plaintext: string): { ok: boolean; error?: string } {
  const trimmed = plaintext.trim();
  if (!trimmed) return { ok: false, error: 'Key is empty' };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS encryption unavailable; refusing to store the key in plaintext' };
  }
  const p = keyPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, safeStorage.encryptString(trimmed), { mode: 0o600 });
  return { ok: true };
}

export function clearKey(): void {
  const p = keyPath();
  if (existsSync(p)) unlinkSync(p);
}

/** Main-process only. Returns null when no key is stored. */
export function readKey(): string | null {
  const p = keyPath();
  if (!existsSync(p)) return null;
  try {
    return safeStorage.decryptString(readFileSync(p));
  } catch {
    // A key encrypted under a different OS user or machine cannot be recovered.
    return null;
  }
}
