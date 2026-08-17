import { useEffect, useMemo, useRef, useState } from 'react';
import { FEATURE_TYPE_LABELS, type FeatureType } from '@shared/taxonomy';
import { loadCatalog, type Catalog, type MobileFeature } from './lib/catalog';
import { search, type MobileCandidate } from './lib/search';
import { FeatureSheet } from './components/FeatureSheet';
import { SetSheet } from './components/SetSheet';

/**
 * Typing is faster than the network but slower than the index.
 *
 * Search runs entirely on the device, so the delay is not there to spare a server -- it is
 * there because a full pass over the alias index on every keystroke competes with the
 * keyboard for the main thread, and a laggy keyboard reads as a broken app. 120ms is below
 * the threshold where a result list feels like it is trailing the typing.
 */
const DEBOUNCE_MS = 120;

export function App(): React.JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState<FeatureType | ''>('');
  const [jurFilter, setJurFilter] = useState('');

  const [open, setOpen] = useState<MobileCandidate | null>(null);
  const [marked, setMarked] = useState<MobileFeature[]>([]);
  const [showSet, setShowSet] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadCatalog(controller.signal)
      .then(setCatalog)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useMemo(() => {
    if (!catalog || debounced.trim().length < 2) return null;
    return search(catalog, debounced, {
      featureTypeFilter: typeFilter || null,
      jurisdictionFilter: jurFilter || null,
    });
  }, [catalog, debounced, typeFilter, jurFilter]);

  /** Types actually present in this index, so the filter cannot offer an empty option. */
  const types = useMemo(
    () =>
      catalog
        ? [...catalog.types].sort((a, b) =>
            (FEATURE_TYPE_LABELS[a] ?? a).localeCompare(FEATURE_TYPE_LABELS[b] ?? b),
          )
        : [],
    [catalog],
  );

  const toggleMark = (feature: MobileFeature): void => {
    setMarked((prev) =>
      prev.some((m) => m.id === feature.id) ? prev.filter((m) => m.id !== feature.id) : [...prev, feature],
    );
  };

  if (loadError) {
    return (
      <div className="boot err">
        <h1>The catalog would not load.</h1>
        <p className="msg err">{loadError}</p>
        <p>
          The index is a single file served next to the app. If this is a fresh deploy, it may not have been
          built yet — <code>npm run index:mobile</code> writes it.
        </p>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="boot">
        <h1>GIS Browser</h1>
        <p>Loading the catalog…</p>
        <p className="dim">One download, then search works offline.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="bar">
        <input
          ref={inputRef}
          className="search"
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Parry Island First Nation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search boundaries"
        />

        <div className="filters">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as FeatureType | '')}>
            <option value="">Any type</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {FEATURE_TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
          <select value={jurFilter} onChange={(e) => setJurFilter(e.target.value)}>
            <option value="">Anywhere</option>
            {catalog.jurisdictions.map((j) => (
              <option key={j.code} value={j.code}>
                {j.label} ({j.count.toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="results">
        {results?.notes.map((n) => (
          <p key={n} className="msg warn">
            {n}
          </p>
        ))}

        {!results && (
          <div className="empty">
            <p>
              <b>{catalog.features.size.toLocaleString()}</b> boundaries indexed,{' '}
              <b>{catalog.jurisdictions.length}</b> jurisdictions.
            </p>
            <p className="dim">
              Type a place. A whole sentence works — “the federal riding of Parry Sound-Muskoka” — the same
              parser the desktop app uses reads it.
            </p>
          </div>
        )}

        {results && results.candidates.length === 0 && (
          <div className="empty">
            <p>Nothing matched “{debounced}”.</p>
            <p className="dim">
              Only per-feature services are on a phone; bulk-file sources are desktop-only because a browser
              cannot fetch them at all.
            </p>
          </div>
        )}

        <ul className="list">
          {results?.candidates.map((c) => {
            const isMarked = marked.some((m) => m.id === c.feature.id);
            return (
              <li key={c.feature.id}>
                <button type="button" className="row" onClick={() => setOpen(c)}>
                  <span className="row-name">{c.feature.name}</span>
                  <span className="row-meta">
                    {FEATURE_TYPE_LABELS[c.feature.featureType] ?? c.feature.featureType}
                    {c.feature.jurisdiction && (
                      <> · {catalog.jurisdictionLabels.get(c.feature.jurisdiction) ?? c.feature.jurisdiction}</>
                    )}
                  </span>
                  <span className="row-source">{c.feature.source.name}</span>
                </button>
                <button
                  type="button"
                  className={isMarked ? 'icon on' : 'icon'}
                  onClick={() => toggleMark(c.feature)}
                  aria-pressed={isMarked}
                  aria-label={isMarked ? `Remove ${c.feature.name} from export set` : `Add ${c.feature.name} to export set`}
                >
                  {isMarked ? '★' : '☆'}
                </button>
              </li>
            );
          })}
        </ul>

        {results && (
          <p className="footnote">
            {results.candidates.length} shown · {results.elapsedMs} ms · index built {catalog.built} · v
            {__APP_VERSION__}
          </p>
        )}
      </main>

      {marked.length > 0 && !open && !showSet && (
        <button type="button" className="setbar" onClick={() => setShowSet(true)}>
          {marked.length} selected — export as one file
        </button>
      )}

      {open && (
        <FeatureSheet
          candidate={open}
          indexedAt={catalog.built}
          jurisdictionLabels={catalog.jurisdictionLabels}
          marked={marked.some((m) => m.id === open.feature.id)}
          onToggleMark={() => toggleMark(open.feature)}
          onClose={() => setOpen(null)}
        />
      )}

      {showSet && (
        <SetSheet
          features={marked}
          indexedAt={catalog.built}
          onRemove={(id) => {
            const next = marked.filter((m) => m.id !== id);
            setMarked(next);
            if (next.length === 0) setShowSet(false);
          }}
          onClose={() => setShowSet(false)}
        />
      )}
    </div>
  );
}
