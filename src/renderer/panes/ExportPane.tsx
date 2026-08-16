import { useState } from 'react';
import type { Candidate } from '@shared/types';

interface Props {
  candidate: Candidate | null;
}

/** Projections offered for SVG export. GeoJSON is always EPSG:4326 per RFC 7946. */
const PROJECTIONS = [
  { code: 'EPSG:3347', label: 'Lambert (Statistics Canada) — default' },
  { code: 'EPSG:3005', label: 'BC Albers' },
  { code: 'EPSG:3857', label: 'Web Mercator' },
];

export function ExportPane({ candidate }: Props): React.JSX.Element {
  const [format, setFormat] = useState<'geojson' | 'svg'>('geojson');
  const [projection, setProjection] = useState(PROJECTIONS[0]!.code);
  const [retention, setRetention] = useState(5);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);

  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">Export</div>

      <div className="pane-body" style={{ padding: 8 }}>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as 'geojson' | 'svg')}>
            <option value="geojson">GeoJSON — RFC 7946, EPSG:4326</option>
            <option value="svg">SVG — projected, Illustrator ready</option>
          </select>
        </label>

        {format === 'svg' && (
          <>
            <label className="field">
              <span>Projection</span>
              <select value={projection} onChange={(e) => setProjection(e.target.value)}>
                {PROJECTIONS.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Canvas</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
                <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} />
              </div>
            </label>
          </>
        )}

        <label className="field">
          <span>Simplification — {retention}% of vertices retained</span>
          <input
            type="range"
            min={1}
            max={100}
            value={retention}
            style={{ width: '100%' }}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
        </label>

        <div className="readout" style={{ marginTop: 4 }}>
          <span>
            before <b>—</b>
          </span>
          <span>
            after <b>—</b>
          </span>
        </div>

        <div className="empty" style={{ paddingLeft: 0 }}>
          Export arrives in M5: topology-preserving Visvalingam via mapshaper, right-hand-rule
          winding, and a <code>_provenance</code> block carrying source, licence, vintage and
          retrieval time.
        </div>
      </div>

      <div className="pane-footer">
        <label className="field">
          <span>On-air credit</span>
          <input
            type="text"
            readOnly
            value={candidate?.attribution ?? ''}
            placeholder="attribution appears once a candidate is selected"
          />
        </label>
        <button className="primary" disabled>
          Export
        </button>
      </div>
    </section>
  );
}
