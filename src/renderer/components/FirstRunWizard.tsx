import { useState } from 'react';
import type { FirstRunStatus, StarterPlan } from '@shared/ipc';
import type { HarvestProgress } from '@shared/types';

interface Props {
  status: FirstRunStatus;
  /** Live harvest progress, so the wizard shows the work it started. */
  progress: HarvestProgress[];
  onDone: () => void;
}

/**
 * What a new install sees.
 *
 * A fresh catalog has 44 seeded sources and zero features, so every search comes back
 * empty and the app looks broken to someone who has done nothing wrong. This exists to
 * get from that state to a working one, and then get out of the way.
 *
 * It is an overlay, not a modal dialog: it can be dismissed at any point, it never traps
 * focus, and skipping it leaves a perfectly usable app with an empty catalog rather than
 * a half-configured one.
 */
export function FirstRunWizard({ status, progress, onDone }: Props): React.JSX.Element {
  const [plan, setPlan] = useState<StarterPlan>('essential');
  const [key, setKey] = useState('');
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = progress.filter((p) => p.phase !== 'done' && p.phase !== 'failed');
  const finished = progress.filter((p) => p.phase === 'done').length;
  const failed = progress.filter((p) => p.phase === 'failed').length;

  async function begin(): Promise<void> {
    setError(null);

    // The key is optional and saved before the harvest starts, so a slow first harvest
    // does not hold it hostage. It goes straight to main and is never kept here.
    if (key.trim()) {
      const res = await window.gis.keySet(key.trim());
      setKey('');
      if (!res.ok) {
        setError(res.error ?? 'That key could not be stored.');
        return;
      }
    }

    const res = await window.gis.firstRunStart(plan);
    if (!res.ok) {
      setError(res.error ?? 'Could not start the first harvest.');
      return;
    }
    if (plan === 'skip' || res.started === 0) {
      onDone();
      return;
    }
    setStarted(true);
  }

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-head">
          <h1>
            GIS <span>Browser</span>
          </h1>
          <button className="link-button" onClick={() => void window.gis.firstRunDismiss().then(onDone)}>
            skip for now
          </button>
        </div>

        {!started ? (
          <>
            <p>
              Ask for a Canadian boundary in plain language and get back a clean GeoJSON or SVG
              outline from official open data, with its source and licence attached.
            </p>
            <p className="dim">
              {status.sourceCount} sources are registered but nothing is indexed yet, so searches
              will find nothing until a first harvest runs. This indexes names only — boundary
              geometry is fetched when you actually export something.
            </p>

            <label className={`wizard-option${plan === 'essential' ? ' sel' : ''}`}>
              <input
                type="radio"
                checked={plan === 'essential'}
                onChange={() => setPlan('essential')}
              />
              <div>
                <b>Essential — {status.essentialCount} sources</b>
                <div className="dim">
                  Federal and provincial ridings, provinces, reserves, municipalities and census
                  subdivisions. A few minutes. Recommended.
                </div>
              </div>
            </label>

            <label className={`wizard-option${plan === 'tier-a' ? ' sel' : ''}`}>
              <input type="radio" checked={plan === 'tier-a'} onChange={() => setPlan('tier-a')} />
              <div>
                <b>Everything queryable — {status.tierACount} sources</b>
                <div className="dim">
                  Adds census tracts, postal areas, parks, watersheds and the rest. Considerably
                  longer.
                </div>
              </div>
            </label>

            <label className={`wizard-option${plan === 'skip' ? ' sel' : ''}`}>
              <input type="radio" checked={plan === 'skip'} onChange={() => setPlan('skip')} />
              <div>
                <b>Nothing yet</b>
                <div className="dim">Pick sources yourself in the Sources pane.</div>
              </div>
            </label>

            {/* Bulk downloads are never part of this. The brief makes them explicitly
                user-triggered, and a wizard quietly pulling 197 MB would be the opposite. */}
            <div className="dim wizard-note">
              Bulk file sources are left out of all of these — they are whole-file downloads and
              you start those yourself, with the size shown first.
            </div>

            {!status.hasAnthropicKey && (
              <label className="field">
                <span>Anthropic API key — optional</span>
                <input
                  type="password"
                  value={key}
                  placeholder="sk-ant-…  leave blank to use the built-in parser"
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            <div className="dim wizard-note">
              Search works without a key: names, a looser pass, then fuzzy matching, all locally.
              A key adds Claude&apos;s parsing and ranking. It is encrypted by Windows and never
              leaves your machine except to Anthropic.
            </div>

            {error && <div className="warn-line error">{error}</div>}

            <div className="wizard-actions">
              <span className="dim mono">Exports will be written to {status.exportFolder}</span>
              <button className="primary" onClick={() => void begin()}>
                {plan === 'skip' ? 'Continue' : 'Start indexing'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Indexing {finished + active.length + failed} sources. You can close this and use the
              app while it runs — the Sources pane shows the same progress.
            </p>

            <div className="wizard-progress">
              {active.slice(0, 6).map((p) => (
                <div key={p.sourceId} className="wizard-progress-row">
                  <span className="name">{p.sourceName}</span>
                  <span className="dim">
                    {p.phase} {p.fetched}
                    {p.expected ? `/${p.expected}` : ''}
                  </span>
                </div>
              ))}
              {active.length === 0 && <div className="dim">Starting…</div>}
            </div>

            <div className="dim">
              {finished} done{failed > 0 ? `, ${failed} failed` : ''}
              {failed > 0 && ' — the Sources pane lists which, with the reason.'}
            </div>

            <div className="wizard-actions">
              <span className="spacer" />
              <button className="primary" onClick={onDone}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
