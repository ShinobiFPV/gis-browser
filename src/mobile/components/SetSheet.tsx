import { useEffect, useRef, useState } from 'react';
import { FEATURE_TYPE_LABELS } from '@shared/taxonomy';
import type { MobileFeature } from '../lib/catalog';
import { getGeometry, type MobileGeometry } from '../lib/geometry';
import { useBackToClose } from '../lib/use-back-to-close';
import type { ExportInput } from '../lib/export';
import { ExportControls } from './ExportControls';

interface Props {
  features: MobileFeature[];
  indexedAt: string;
  onRemove: (id: number) => void;
  onClose: () => void;
}

interface Loaded {
  byFeature: Map<number, MobileGeometry>;
  failed: Map<number, string>;
}

/**
 * The export set: several boundaries in one file.
 *
 * Geometry is fetched ONE AT A TIME, deliberately. The desktop runs three concurrent
 * requests per host; a phone on LTE pulling twelve ridings in parallel gets twelve slow
 * downloads instead of twelve quick ones, and every one of them can time out together. In
 * series the artist also watches a counter move, which is the difference between waiting
 * and wondering.
 *
 * A boundary that fails does not sink the set. It is listed with its reason and left out of
 * the file, because an artist on deadline with eleven of twelve ridings has something to put
 * on air and an error page has nothing.
 */
export function SetSheet({ features, indexedAt, onRemove, onClose }: Props): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ byFeature: new Map(), failed: new Map() });
  const [fetching, setFetching] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const controller = new AbortController();

    void (async () => {
      for (const feature of features) {
        if (cancelled.current) return;
        setFetching(feature.name);
        try {
          const result = await getGeometry(feature, controller.signal);
          if (cancelled.current) return;
          setLoaded((prev) => ({
            byFeature: new Map(prev.byFeature).set(feature.id, result),
            failed: prev.failed,
          }));
        } catch (err) {
          if (cancelled.current) return;
          setLoaded((prev) => ({
            byFeature: prev.byFeature,
            failed: new Map(prev.failed).set(feature.id, err instanceof Error ? err.message : String(err)),
          }));
        }
      }
      setFetching(null);
    })();

    return () => {
      cancelled.current = true;
      controller.abort();
    };
    // Keyed on the membership, not the array identity: re-rendering must not restart the run.
  }, [features.map((f) => f.id).join(',')]);

  useBackToClose(onClose);

  const inputs: ExportInput[] = features
    .map((feature) => {
      const result = loaded.byFeature.get(feature.id);
      return result
        ? {
            feature,
            geometry: result.geometry,
            vertexCount: result.vertexCount,
            generalisationDeg: result.generalisationDeg,
          }
        : null;
    })
    .filter((i): i is ExportInput => i !== null);

  const vertices = inputs.reduce((n, i) => n + i.vertexCount, 0);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Export set">
      <header className="sheet-head">
        <button type="button" className="icon" onClick={onClose} aria-label="Back to results">
          ←
        </button>
        <h1>
          Export set <span className="dim">({features.length})</span>
        </h1>
        <span className="icon" aria-hidden="true" />
      </header>

      <div className="sheet-body">
        <ul className="set-list">
          {features.map((f) => {
            const failure = loaded.failed.get(f.id);
            const result = loaded.byFeature.get(f.id);
            return (
              <li key={f.id} className={failure ? 'failed' : ''}>
                <div className="set-name">
                  <b>{f.name}</b>
                  <span className="dim">{FEATURE_TYPE_LABELS[f.featureType] ?? f.featureType}</span>
                  {failure && <span className="msg err">{failure}</span>}
                </div>
                <span className="set-state">
                  {result ? `${result.vertexCount.toLocaleString()} pts` : failure ? 'failed' : '…'}
                </span>
                <button type="button" className="icon" onClick={() => onRemove(f.id)} aria-label={`Remove ${f.name}`}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>

        <p className="field-note">
          {inputs.length} of {features.length} ready · {vertices.toLocaleString()} vertices
          {loaded.failed.size > 0 && ` · ${loaded.failed.size} left out`}
        </p>

        <ExportControls
          inputs={inputs}
          indexedAt={indexedAt}
          pending={
            fetching
              ? `Fetching ${fetching}… (${loaded.byFeature.size + loaded.failed.size} of ${features.length})`
              : inputs.length === 0
                ? 'None of these boundaries could be fetched, so there is nothing to export.'
                : null
          }
        />
      </div>
    </div>
  );
}
