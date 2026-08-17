import type { UpdateStatus } from '@shared/ipc';

interface Props {
  status: UpdateStatus;
  onChanged: (next: UpdateStatus) => void;
}

/**
 * A one-line notice that a newer release exists.
 *
 * Not a dialog, and deliberately not a download prompt. The app checks and links; the
 * install is the same manual step it was the first time, because auto-installing needs
 * code signing the project does not have.
 *
 * It sits under the titlebar and can be dismissed for that version. Someone mid-bulletin
 * should be able to make it go away in one click and never see it again until the next
 * release.
 */
export function UpdateBanner({ status, onChanged }: Props): React.JSX.Element | null {
  if (!status.updateAvailable || !status.latestVersion) return null;

  return (
    <div className="update-banner">
      <span className="update-dot" />
      <span>
        Version <b>{status.latestVersion}</b> is available. You are running{' '}
        <b>{status.currentVersion}</b>.
      </span>

      {status.releaseUrl && (
        <button
          className="link-button"
          onClick={() => void window.gis.updateOpen(status.releaseUrl!)}
        >
          view release
        </button>
      )}

      <button
        className="link-button"
        onClick={() => void window.gis.updateSkip(status.latestVersion!).then(onChanged)}
      >
        skip this version
      </button>

      <span className="spacer" />
      <span className="dim">Downloading and installing is manual — the build is unsigned.</span>
    </div>
  );
}
