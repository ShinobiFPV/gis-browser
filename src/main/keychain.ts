import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * API key storage, one key per provider.
 *
 * Each key is encrypted with Electron's safeStorage (DPAPI on Windows, Keychain on macOS)
 * and written beside the app data -- deliberately NOT into the SQLite catalog, which the
 * user may copy around or hand to someone else. Keys are never sent to the renderer,
 * never logged, and only ever read inside main at the moment a request is built.
 *
 * Keys are kept per provider rather than one at a time, so switching from Claude to
 * OpenAI and back does not mean re-entering credentials. Switching provider is meant to
 * be a dropdown, not a chore.
 */

/** Provider ids are a closed set, but this is defence against ever building a path from one. */
function safeId(providerId: string): string {
  const clean = providerId.replace(/[^a-z0-9-]/gi, '');
  if (!clean) throw new Error(`Invalid provider id: ${JSON.stringify(providerId)}`);
  return clean;
}

function keyDir(): string {
  return join(app.getPath('userData'), 'keys');
}

function keyPath(providerId: string): string {
  return join(keyDir(), `${safeId(providerId)}.key`);
}

/**
 * Moves the single pre-multi-provider key into the per-provider layout.
 *
 * Before providers were switchable there was one file, `anthropic.key`. Someone upgrading
 * should not have to find and re-enter a key they already gave the app.
 */
function migrateLegacyKey(): void {
  const legacy = join(app.getPath('userData'), 'anthropic.key');
  if (!existsSync(legacy)) return;

  const target = keyPath('anthropic');
  if (existsSync(target)) {
    // Already migrated and a newer key was entered since. The old file is stale.
    unlinkSync(legacy);
    return;
  }

  mkdirSync(keyDir(), { recursive: true });
  // Renamed rather than re-encrypted: the ciphertext is already correct for this user,
  // and decrypting to move it would put the key in memory for no reason.
  renameSync(legacy, target);
  console.log('[keychain] migrated the legacy Anthropic key into the per-provider store');
}

export function hasKey(providerId: string): boolean {
  migrateLegacyKey();
  return existsSync(keyPath(providerId));
}

/** Which providers currently have a key stored. Never returns the keys themselves. */
export function providersWithKeys(providerIds: string[]): string[] {
  migrateLegacyKey();
  return providerIds.filter((id) => existsSync(keyPath(id)));
}

export function setKey(providerId: string, plaintext: string): { ok: boolean; error?: string } {
  const trimmed = plaintext.trim();
  if (!trimmed) return { ok: false, error: 'Key is empty' };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS encryption unavailable; refusing to store the key in plaintext' };
  }
  mkdirSync(keyDir(), { recursive: true });
  writeFileSync(keyPath(providerId), safeStorage.encryptString(trimmed), { mode: 0o600 });
  return { ok: true };
}

export function clearKey(providerId: string): void {
  const p = keyPath(providerId);
  if (existsSync(p)) unlinkSync(p);
  if (providerId === 'anthropic') {
    const legacy = join(app.getPath('userData'), 'anthropic.key');
    if (existsSync(legacy)) unlinkSync(legacy);
  }
}

/** Main-process only. Returns null when no key is stored for that provider. */
export function readKey(providerId: string): string | null {
  migrateLegacyKey();
  const p = keyPath(providerId);
  if (!existsSync(p)) return null;
  try {
    return safeStorage.decryptString(readFileSync(p));
  } catch {
    // A key encrypted under a different OS user or machine cannot be recovered.
    return null;
  }
}
