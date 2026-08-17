import { app } from 'electron';
import type { UpdateStatus } from '@shared/ipc';
import { isNewer } from '@shared/version';
import { HttpClient } from '../harvester/http';
import { getSetting, setSetting } from './settings';

/**
 * Checking whether a newer release exists.
 *
 * This CHECKS. It does not download or install anything, and that is a deliberate limit
 * rather than an unfinished one: installing an update in the background requires the app
 * to be code-signed, and on macOS specifically Squirrel refuses an unsigned update
 * outright. Shipping a silent auto-installer that can only ever work on one of the two
 * platforms would be worse than a link that works on both.
 *
 * So: it asks GitHub what the latest release is, compares versions, and tells the user.
 * They click through and install it themselves, the same way they installed it the first
 * time.
 */

const RELEASES_API = 'https://api.github.com/repos/ShinobiFPV/gis-browser/releases/latest';

/**
 * Minimum gap between automatic checks.
 *
 * Unauthenticated GitHub allows 60 requests an hour per IP. One check per launch is
 * nothing, but an app that gets restarted repeatedly while someone works should not be
 * the reason that budget runs out.
 */
const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Deliberately short. This runs in the background on startup and nobody is waiting for
 * it; a slow answer should be abandoned, not retried into a stall.
 */
const http = new HttpClient({
  timeoutMs: 10_000,
  maxAttempts: 2,
  log: (level, message) => {
    if (level === 'warn' || level === 'error') console.warn(`[updates] ${message}`);
  },
});

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string;
}

/**
 * What is actually running.
 *
 * The build-time constant is authoritative. app.getVersion() is only a fallback for a
 * context where the define did not apply, and it is known to return ELECTRON's version
 * when the app path carries no manifest -- which is exactly what the CLI does.
 */
function currentVersion(): string {
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__;
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

/** The last result, so the UI can render without triggering a fresh request. */
let lastStatus: UpdateStatus | null = null;

/**
 * Status built from what was persisted, so it survives a restart.
 *
 * Checks are throttled to one every six hours. Holding the result only in memory meant a
 * relaunch inside that window reported nothing and the update silently disappeared from
 * the UI -- the exact window in which someone who just saw the notice would restart.
 */
function persistedStatus(): UpdateStatus {
  const current = currentVersion();
  const latest = getSetting('lastKnownVersion');
  const skipped = getSetting('skippedUpdateVersion');

  return {
    currentVersion: current,
    latestVersion: latest,
    updateAvailable: latest !== null && isNewer(latest, current) && latest !== skipped,
    releaseUrl: getSetting('lastKnownReleaseUrl'),
    publishedAt: getSetting('lastKnownPublishedAt'),
    checkedAt: getSetting('lastUpdateCheckAt'),
    enabled: getSetting('updateCheckEnabled'),
    skippedVersion: skipped,
    error: null,
  };
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus ?? persistedStatus();
}

export interface CheckOptions {
  /** Ignore both the interval and the enabled setting. Set when a person clicks Check. */
  force?: boolean;
}

export async function checkForUpdates(opts: CheckOptions = {}): Promise<UpdateStatus> {
  const current = currentVersion();
  const base = persistedStatus();

  if (!opts.force) {
    if (!getSetting('updateCheckEnabled')) {
      lastStatus = base;
      return base;
    }
    const last = getSetting('lastUpdateCheckAt');
    if (last && Date.now() - Date.parse(last) < MIN_CHECK_INTERVAL_MS) {
      // Checked recently. Return what is known rather than asking again.
      lastStatus = lastStatus ?? base;
      return lastStatus;
    }
  }

  let release: GithubRelease;
  try {
    release = await http.getJson<GithubRelease>(RELEASES_API);
  } catch (err) {
    // Being offline is the normal case for a laptop that has not connected yet, not an
    // error worth putting in front of anyone. Recorded, shown only if they ask.
    const status: UpdateStatus = {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
    setSetting('lastUpdateCheckAt', status.checkedAt);
    lastStatus = status;
    return status;
  }

  setSetting('lastUpdateCheckAt', new Date().toISOString());

  const tag = release.tag_name?.trim();
  if (!tag || release.draft) {
    const status: UpdateStatus = { ...base, checkedAt: new Date().toISOString() };
    lastStatus = status;
    return status;
  }

  const latest = tag.replace(/^v/, '');
  const skipped = getSetting('skippedUpdateVersion');

  const status: UpdateStatus = {
    currentVersion: current,
    latestVersion: latest,
    // A version the user explicitly skipped is not "available" until a newer one appears.
    updateAvailable: isNewer(latest, current) && latest !== skipped,
    releaseUrl: release.html_url ?? null,
    publishedAt: release.published_at ?? null,
    checkedAt: new Date().toISOString(),
    enabled: getSetting('updateCheckEnabled'),
    skippedVersion: skipped,
    error: null,
  };

  // Persisted so the answer outlives this process, not just this check.
  setSetting('lastKnownVersion', latest);
  setSetting('lastKnownReleaseUrl', status.releaseUrl);
  setSetting('lastKnownPublishedAt', status.publishedAt);

  console.log(
    `[updates] running ${current}, latest ${latest}` +
      `${status.updateAvailable ? ' — update available' : ''}`,
  );

  lastStatus = status;
  return status;
}

/** Suppresses a specific version. A later one still appears. */
export function skipVersion(version: string): UpdateStatus {
  setSetting('skippedUpdateVersion', version);
  if (lastStatus) {
    lastStatus = { ...lastStatus, updateAvailable: false, skippedVersion: version };
  }
  return getUpdateStatus();
}

export function setUpdateChecksEnabled(enabled: boolean): UpdateStatus {
  setSetting('updateCheckEnabled', enabled);
  if (lastStatus) lastStatus = { ...lastStatus, enabled };
  return getUpdateStatus();
}

/**
 * Fires the startup check without blocking anything.
 *
 * Delayed rather than immediate: the first seconds after launch belong to opening the
 * catalog and painting a window, and an update notice is never urgent enough to compete
 * with that.
 */
export function scheduleStartupCheck(onResult: (status: UpdateStatus) => void): void {
  setTimeout(() => {
    void checkForUpdates()
      .then(onResult)
      .catch((err: unknown) => {
        console.warn(`[updates] startup check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, 8000);
}
