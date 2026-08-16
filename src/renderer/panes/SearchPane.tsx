import { useEffect, useState, type RefObject } from 'react';
import type { Candidate } from '@shared/types';
import type { SearchResponse } from '@shared/ipc';
import { FEATURE_TYPES, FEATURE_TYPE_LABELS, JURISDICTIONS, type FeatureType } from '@shared/taxonomy';
import { LocatorThumb } from '../components/LocatorThumb';

interface Props {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  selected: Candidate | null;
  onSelect: (c: Candidate | null) => void;
  hasKey: boolean;
  /** Dev harness only; see App.tsx. Runs this query on mount and picks the top hit. */
  demoQuery?: string | null;
}

/** The brief is explicit: always show the top five, never auto-export any of them. */
const ALWAYS_SHOWN = 5;

export function SearchPane({ promptRef, selected, onSelect, hasKey, demoQuery }: Props): React.JSX.Element {
  const [prompt, setPrompt] = useState(demoQuery ?? '');
  const [useLlm, setUseLlm] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [jurFilter, setJurFilter] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showAll, setShowAll] = useState(false);

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
    setShowAll(false);
    try {
      const res = await window.gis.searchRun({
        prompt: text,
        useLlm,
        featureTypeFilter: typeFilter || null,
        jurisdictionFilter: jurFilter || null,
      });
      setResponse(res);
      // Never auto-select, even on a single high-confidence hit. A wrong boundary on air
      // costs far more than a click. (The dev harness is the one exception.)
      onSelect(autoSelectTop ? (res.candidates[0] ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResponse(null);
    } finally {
      setRunning(false);
    }
  }

  const candidates = response?.candidates ?? [];
  const shown = showAll ? candidates : candidates.slice(0, ALWAYS_SHOWN);
  const parsed = response?.parsed;

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

      {/* What the parser understood, so a bad parse is visible rather than mysterious. */}
      {parsed && (
        <div className="parsed-strip" title={parsed.notes}>
          <span className="mono">“{parsed.placeNames[0]}”</span>
          {parsed.featureTypeHint && <span className="chip">{FEATURE_TYPE_LABELS[parsed.featureTypeHint as FeatureType]}</span>}
          {parsed.jurisdictionHint && <span className="chip">{parsed.jurisdictionHint}</span>}
          {parsed.vintageHint && <span className="chip">{parsed.vintageHint}</span>}
          <span className="spacer" />
          <span className="via">{parsed.via}</span>
        </div>
      )}

      <div className="pane-body">
        {error && <div className="empty">{error}</div>}

        {!error && !response && (
          <div className="empty">
            Type a plain-language request and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>.
            <br />
            <br />
            Matching runs entirely locally: exact names, then a looser pass for extra words,
            then fuzzy for typos. The Claude parser arrives in M4. The top five are always
            listed for you to choose from — nothing is ever auto-exported, however confident
            the match.
          </div>
        )}

        {response && candidates.length === 0 && (
          <div className="empty">
            No match for that name in the catalog.
            <br />
            <br />
            Either the place is in a source that has not been harvested yet, or it is filed
            under a different name. Nothing is guessed at.
          </div>
        )}

        {shown.map((c, i) => (
          <div
            key={c.featureId}
            className={`cand${selected?.featureId === c.featureId ? ' sel' : ''}`}
            onClick={() => onSelect(c)}
            title={c.justification ?? ''}
          >
            <div className="cand-rank">{i + 1}</div>
            <LocatorThumb bbox={c.bbox} active={selected?.featureId === c.featureId} />
            <div className="cand-main">
              <div className="cand-name">
                {c.officialName}
                <span className={c.hasCachedGeometry ? 'dot cached' : 'dot'} title={c.hasCachedGeometry ? 'geometry cached' : 'geometry not fetched yet'} />
              </div>
              <div className="cand-meta">
                <span>{FEATURE_TYPE_LABELS[c.featureType]}</span>
                <span>{c.jurisdiction ?? '—'}</span>
                <span className="cand-source">{c.sourceName}</span>
              </div>
              {c.justification && <div className="cand-why">{c.justification}</div>}
            </div>
            <div className="cand-score mono">{c.matchScore.toFixed(2)}</div>
          </div>
        ))}

        {candidates.length > ALWAYS_SHOWN && (
          <button className="link-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'show top 5 only' : `show ${candidates.length - ALWAYS_SHOWN} more`}
          </button>
        )}
      </div>
    </section>
  );
}
