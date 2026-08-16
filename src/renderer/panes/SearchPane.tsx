import { useState, type RefObject } from 'react';
import type { Candidate } from '@shared/types';
import { FEATURE_TYPES, FEATURE_TYPE_LABELS, JURISDICTIONS, type FeatureType } from '@shared/taxonomy';

interface Props {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  onSelect: (c: Candidate | null) => void;
  hasKey: boolean;
}

export function SearchPane({ promptRef, onSelect, hasKey }: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [useLlm, setUseLlm] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [jurFilter, setJurFilter] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    if (!prompt.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await window.gis.searchRun({
        prompt,
        useLlm,
        featureTypeFilter: typeFilter || null,
        jurisdictionFilter: jurFilter || null,
      });
      setCandidates(res.candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCandidates([]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">
        Search
        <span className="hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> run
        </span>
      </div>

      <div className="prompt-box">
        <textarea
          ref={promptRef}
          value={prompt}
          placeholder={'Give me the outline shape for Parry Island First Nation'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div className="prompt-actions">
          <label className="toggle" title={hasKey ? '' : 'Add an Anthropic API key in Settings to enable'}>
            <input type="checkbox" checked={useLlm} disabled={!hasKey} onChange={(e) => setUseLlm(e.target.checked)} />
            Claude parse + rank
          </label>
          <span className="spacer" />
          <button className="primary" disabled={running || !prompt.trim()} onClick={() => void run()}>
            {running ? 'Searching…' : 'Search'}
          </button>
        </div>
        <div className="prompt-actions">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">any type</option>
            {FEATURE_TYPES.map((t) => (
              <option key={t} value={t}>
                {FEATURE_TYPE_LABELS[t as FeatureType]}
              </option>
            ))}
          </select>
          <select value={jurFilter} onChange={(e) => setJurFilter(e.target.value)}>
            <option value="">anywhere</option>
            {JURISDICTIONS.map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="pane-body">
        {error && <div className="empty">{error}</div>}
        {!error && candidates.length === 0 && (
          <div className="empty">
            Type a plain-language request and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.
            <br />
            <br />
            Matching arrives in M3. The top five candidates will always be shown here with map
            thumbnails — nothing is ever auto-exported, however confident the match.
          </div>
        )}
        {candidates.map((c) => (
          <div key={c.featureId} className="src" onClick={() => onSelect(c)}>
            <span />
            <div className="name">{c.officialName}</div>
            <span className="status">{c.matchScore.toFixed(2)}</span>
            <div className="meta">
              <span>{FEATURE_TYPE_LABELS[c.featureType]}</span>
              <span>{c.jurisdiction ?? '—'}</span>
              <span>{c.sourceName}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
