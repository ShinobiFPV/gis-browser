import { FEATURE_TYPE_LABELS } from '@shared/taxonomy';
import type { MobileCandidate } from '../lib/search';
import { useBackToClose } from '../lib/use-back-to-close';
import { useGeometry } from '../lib/use-geometry';
import { BoundaryPreview } from './BoundaryPreview';
import { ExportControls } from './ExportControls';

interface Props {
  candidate: MobileCandidate;
  indexedAt: string;
  jurisdictionLabels: Map<string, string>;
  marked: boolean;
  onToggleMark: () => void;
  onClose: () => void;
}

/**
 * One boundary, full screen.
 *
 * The geometry is fetched on open rather than behind a button. On a phone the sequence is
 * search, tap, look, export, and inserting a "load" tap between "tap" and "look" adds a
 * step to every single use in order to save data on the rare open-by-accident. The fetch is
 * abortable and closing the sheet aborts it, which covers the accident.
 */
export function FeatureSheet({
  candidate,
  indexedAt,
  jurisdictionLabels,
  marked,
  onToggleMark,
  onClose,
}: Props): React.JSX.Element {
  const { feature } = candidate;
  const { result, loading, error, retry } = useGeometry(feature);

  useBackToClose(onClose);

  const jurisdiction = feature.jurisdiction
    ? (jurisdictionLabels.get(feature.jurisdiction) ?? feature.jurisdiction)
    : null;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={feature.name}>
      <header className="sheet-head">
        <button type="button" className="icon" onClick={onClose} aria-label="Back to results">
          ←
        </button>
        <h1>{feature.name}</h1>
        <button
          type="button"
          className={marked ? 'icon on' : 'icon'}
          onClick={onToggleMark}
          aria-pressed={marked}
          aria-label={marked ? 'Remove from export set' : 'Add to export set'}
        >
          {marked ? '★' : '☆'}
        </button>
      </header>

      <div className="sheet-body">
        <div className="preview-shell">
          <BoundaryPreview geometry={result?.geometry ?? null} bbox={feature.bbox} />
          {loading && <div className="overlay">Fetching boundary…</div>}
          {error && (
            <div className="overlay err">
              <span>{error}</span>
              <button type="button" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {result?.generalisationDeg != null && (
            <div className="badge warn">
              generalised at source · {result.generalisationDeg}°
            </div>
          )}
          {result?.fromPack && <div className="badge">bundled outline</div>}
        </div>

        <dl className="facts">
          <div>
            <dt>Type</dt>
            <dd>{FEATURE_TYPE_LABELS[feature.featureType] ?? feature.featureType}</dd>
          </div>
          {jurisdiction && (
            <div>
              <dt>Jurisdiction</dt>
              <dd>{jurisdiction}</dd>
            </div>
          )}
          <div>
            <dt>Source</dt>
            <dd>
              {feature.source.name}
              {feature.source.vintage && <span className="dim"> · {feature.source.vintage}</span>}
            </dd>
          </div>
          <div>
            <dt>Licence</dt>
            <dd>{feature.source.licence || '—'}</dd>
          </div>
          <div>
            <dt>Vertices</dt>
            <dd>{result ? result.vertexCount.toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt>Parts</dt>
            <dd>{result ? result.partCount.toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt>Matched</dt>
            <dd>
              <span className="dim">{candidate.matchedVia}</span> on “{candidate.matchedAlias}” —{' '}
              {candidate.justification}
            </dd>
          </div>
        </dl>

        <ExportControls
          inputs={
            result
              ? [
                  {
                    feature,
                    geometry: result.geometry,
                    vertexCount: result.vertexCount,
                    generalisationDeg: result.generalisationDeg,
                  },
                ]
              : []
          }
          indexedAt={indexedAt}
          pending={result ? null : loading ? 'Waiting for the boundary…' : 'No boundary loaded, so nothing to export.'}
        />
      </div>
    </div>
  );
}
