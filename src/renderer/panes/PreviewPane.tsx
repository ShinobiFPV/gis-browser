import type { Candidate } from '@shared/types';

interface Props {
  candidate: Candidate | null;
}

export function PreviewPane({ candidate }: Props): React.JSX.Element {
  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">
        Preview
        {candidate && <span className="hint">{candidate.officialName}</span>}
      </div>

      <div className="pane-body">
        <div className="map-shell">
          {/* M2 mounts maplibre-gl here and draws the fetched boundary. */}
          <div className="empty">
            {candidate
              ? 'Geometry fetch and map rendering arrive in M2.'
              : 'Select a candidate to preview its boundary.'}
          </div>
        </div>
      </div>

      <div className="pane-footer">
        <div className="readout">
          <span>
            vertices <b>—</b>
          </span>
          <span>
            bbox{' '}
            <b className="mono">
              {candidate?.bbox ? candidate.bbox.map((n) => n.toFixed(3)).join(', ') : '—'}
            </b>
          </span>
          <span>
            cached <b>{candidate ? (candidate.hasCachedGeometry ? 'yes' : 'no') : '—'}</b>
          </span>
        </div>
      </div>
    </section>
  );
}
