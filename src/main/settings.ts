import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, isProviderId } from '@shared/llm-providers';

/**
 * Small preferences file beside the app data.
 *
 * Deliberately not the SQLite catalog: the catalog is a rebuildable cache a user may copy
 * between machines, and preferences are neither. The API key is not here either -- that
 * lives encrypted via safeStorage, in its own file.
 */

export interface Preferences {
  /** Which LLM provider is selected. See shared/llm-providers.ts. */
  llmProvider: string;
  /** Model id for that provider. Free text -- a provider will take one it does not list. */
  llmModel: string;
  /** Base URL, only used by providers whose endpoint is meant to be pointed somewhere. */
  llmBaseUrl: string;
  /**
   * Kept so an install that predates provider switching does not lose its model choice.
   * Read once at load, then carried in llmModel.
   */
  anthropicModel: string;
  /**
   * Where exports land. Set once, then never asked about again -- the brief bans modal
   * dialogs in the search-to-export path, and a native save dialog per export is exactly
   * the interruption it is describing. Changing this folder is a Settings action, which
   * is outside that path.
   */
  exportFolder: string;
  /**
   * When the first-run wizard was completed or deliberately skipped. Null means it has
   * never been answered, which is not the same as the catalog being empty -- see
   * shouldShowWizard.
   */
  firstRunCompletedAt: string | null;

  /**
   * Whether to ask GitHub for the latest release on startup. On by default, and a single
   * request every six hours at most -- but it IS a network call the app makes on its own,
   * so it is disclosed in Settings and can be switched off.
   */
  updateCheckEnabled: boolean;
  lastUpdateCheckAt: string | null;
  /** A version the user chose to ignore. A later one still surfaces. */
  skippedUpdateVersion: string | null;
  /**
   * The last release seen, persisted rather than held in memory.
   *
   * Checks are throttled to one every six hours. Without persisting the result, a restart
   * inside that window would find nothing to report and the update would vanish from the
   * UI until the throttle expired.
   */
  lastKnownVersion: string | null;
  lastKnownReleaseUrl: string | null;
  lastKnownPublishedAt: string | null;
}

function defaultExportFolder(): string {
  // documents rather than userData: these are the artist's deliverables, not app state,
  // and they need to be findable from Illustrator's open dialog without hunting through
  // AppData.
  return join(app.getPath('documents'), 'GIS Browser Exports');
}

const DEFAULTS: Preferences = {
  llmProvider: DEFAULT_PROVIDER,
  llmModel: DEFAULT_MODEL,
  llmBaseUrl: '',
  anthropicModel: DEFAULT_MODEL,
  exportFolder: '',
  firstRunCompletedAt: null,
  updateCheckEnabled: true,
  lastUpdateCheckAt: null,
  skippedUpdateVersion: null,
  lastKnownVersion: null,
  lastKnownReleaseUrl: null,
  lastKnownPublishedAt: null,
};

let cache: Preferences | null = null;

function file(): string {
  return join(app.getPath('userData'), 'preferences.json');
}

function load(): Preferences {
  if (cache) return cache;
  const path = file();
  if (!existsSync(path)) {
    cache = { ...DEFAULTS, exportFolder: defaultExportFolder() };
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Preferences>;
    cache = {
      llmProvider: isProviderId(raw.llmProvider) ? raw.llmProvider : DEFAULTS.llmProvider,
      // Model ids are NOT validated against the built-in list. A provider will happily
      // serve a model we have never heard of, and refusing one because it is not in a
      // hardcoded table would make every new release of every provider unusable until
      // this file caught up.
      llmModel:
        typeof raw.llmModel === 'string' && raw.llmModel.trim()
          ? raw.llmModel.trim()
          : // Carry a pre-multi-provider model choice forward rather than resetting it.
            (typeof raw.anthropicModel === 'string' && raw.anthropicModel.trim()
              ? raw.anthropicModel.trim()
              : DEFAULTS.llmModel),
      llmBaseUrl: typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl : '',
      anthropicModel: typeof raw.anthropicModel === 'string' ? raw.anthropicModel : DEFAULTS.anthropicModel,
      exportFolder:
        typeof raw.exportFolder === 'string' && raw.exportFolder.trim()
          ? raw.exportFolder
          : defaultExportFolder(),
      firstRunCompletedAt:
        typeof raw.firstRunCompletedAt === 'string' ? raw.firstRunCompletedAt : null,
      updateCheckEnabled:
        typeof raw.updateCheckEnabled === 'boolean' ? raw.updateCheckEnabled : DEFAULTS.updateCheckEnabled,
      lastUpdateCheckAt: typeof raw.lastUpdateCheckAt === 'string' ? raw.lastUpdateCheckAt : null,
      skippedUpdateVersion:
        typeof raw.skippedUpdateVersion === 'string' ? raw.skippedUpdateVersion : null,
      lastKnownVersion: typeof raw.lastKnownVersion === 'string' ? raw.lastKnownVersion : null,
      lastKnownReleaseUrl: typeof raw.lastKnownReleaseUrl === 'string' ? raw.lastKnownReleaseUrl : null,
      lastKnownPublishedAt:
        typeof raw.lastKnownPublishedAt === 'string' ? raw.lastKnownPublishedAt : null,
    };
  } catch {
    console.warn('[settings] preferences.json is unreadable; using defaults');
    cache = { ...DEFAULTS, exportFolder: defaultExportFolder() };
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
