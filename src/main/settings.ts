import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { DEFAULT_MODEL, MODELS } from './anthropic';

/**
 * Small preferences file beside the app data.
 *
 * Deliberately not the SQLite catalog: the catalog is a rebuildable cache a user may copy
 * between machines, and preferences are neither. The API key is not here either -- that
 * lives encrypted via safeStorage, in its own file.
 */

export interface Preferences {
  anthropicModel: string;
}

const DEFAULTS: Preferences = { anthropicModel: DEFAULT_MODEL };

let cache: Preferences | null = null;

function file(): string {
  return join(app.getPath('userData'), 'preferences.json');
}

function load(): Preferences {
  if (cache) return cache;
  const path = file();
  if (!existsSync(path)) {
    cache = { ...DEFAULTS };
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Preferences>;
    cache = {
      // An unknown model id would 404 on every request, so fall back rather than trust it.
      anthropicModel: MODELS.some((m) => m.id === raw.anthropicModel)
        ? raw.anthropicModel!
        : DEFAULTS.anthropicModel,
    };
  } catch {
    console.warn('[settings] preferences.json is unreadable; using defaults');
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function getSetting<K extends keyof Preferences>(key: K): Preferences[K] {
  return load()[key];
}

export function getPreferences(): Preferences {
  return { ...load() };
}

export function setSetting<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  const next = { ...load(), [key]: value };
  cache = next;
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
