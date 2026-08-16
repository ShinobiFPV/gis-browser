import { useEffect, useState, type RefObject } from 'react';
import type { Candidate } from '@shared/types';
import { FEATURE_TYPES, FEATURE_TYPE_LABELS, JURISDICTIONS, type FeatureType } from '@shared/taxonomy';

interface Props {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  selected: Candidate | null;
  onSelect: (c: Candidate | null) => void;
  hasKey: boolean;
  /** Dev harness only; see App.tsx. Runs this query on mount and picks the top hit. */
  demoQuery?: string | null;
}

export function SearchPane({ promptRef, selected, onSelect, hasKey, demoQuery }: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState(demoQuery ?? '');
  const [useLlm, setUseLlm] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [jurFilter, setJurFilter] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Dev harness: run the demo query once on mount and select its top hit.
  useEffect(() => {
    if (!demoQuery) return;
    void run(demoQuery, true);
    // Intentionally mount-only.

  }, []);

  async function run(text = prompt, autoSelectTop = false): Promise<void> {
    if (!text.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await window.gis.searchRun({
        prompt: text,
        useLlm,
        featureTypeFilter: typeFilter || null,
        jurisdictionFilter: jurFilter || null,
      });
      setCandidates(res.candidates);
      // Never auto-select, even on a single high-confidence hit. A wrong boundary on air
      // costs far more than a click. (The dev harness is the one exception.)
      onSelect(autoSelectTop ? (res.candidates[0] ?? null) : null);
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
            Type a place name and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.
            <br />
            <br />
            This is a literal name lookup for now — fuzzy matching and ranking arrive in M3, the
            Claude parser in M4. Candidates are always listed for you to choose from; nothing is
            ever auto-exported, however confident the match.
          </div>
        )}
        {candidates.map((c) => (
          <div
            key={c.featureId}
            className={`src${selected?.featureId === c.featureId ? ' sel' : ''}`}
            onClick={() => onSelect(c)}
            title={`${c.officialName} — ${c.sourceName}${c.vintage ? ` (${c.vintage})` : ''}`}
          >
            <span className={c.hasCachedGeometry ? 'dot cached' : 'dot'} title={c.hasCachedGeometry ? 'geometry cached' : 'geometry not fetched yet'} />
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
