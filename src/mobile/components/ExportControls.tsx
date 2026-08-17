import { useState } from 'react';
import { SVG_PROJECTIONS, DEFAULT_SVG_SRID } from '@shared/projections';
import { buildExport, deliver, type ExportFormat, type ExportInput, type ExportedFile } from '../lib/export';

interface Props {
  inputs: ExportInput[];
  /** The date the catalog index was built; written into every provenance block. */
  indexedAt: string;
  /** Shown instead of the controls while geometry is still being fetched. */
  pending?: string | null;
}

/**
 * Format, projection, and the button that gets the file off the phone.
 *
 * Shared between the single-feature sheet and the multi-feature set, because an export of
 * one and an export of twelve differ only in how many inputs are handed to the same
 * builder -- and the moment they stop being the same call is the moment the two start
 * producing different files.
 */
export function ExportControls({ inputs, indexedAt, pending }: Props): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('geojson');
  const [srid, setSrid] = useState(DEFAULT_SVG_SRID);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ file: ExportedFile; how: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const file = buildExport(inputs, format, indexedAt, { srid });
      const how = await deliver(file);
      setDone({ file, how: how === 'shared' ? 'shared' : 'saved to your downloads' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (pending) return <div className="export-pending">{pending}</div>;

  return (
    <div className="export">
      <div className="seg" role="group" aria-label="Export format">
        <button
          type="button"
          className={format === 'geojson' ? 'seg-on' : ''}
          onClick={() => setFormat('geojson')}
        >
          GeoJSON
        </button>
        <button type="button" className={format === 'svg' ? 'seg-on' : ''} onClick={() => setFormat('svg')}>
          SVG
        </button>
      </div>

      {format === 'svg' ? (
        <label className="field">
          <span>Projection</span>
          <select value={srid} onChange={(e) => setSrid(Number(e.target.value))}>
            {SVG_PROJECTIONS.map((p) => (
              <option key={p.srid} value={p.srid}>
                {p.label}
              </option>
            ))}
          </select>
          <em>{SVG_PROJECTIONS.find((p) => p.srid === srid)?.hint}</em>
        </label>
      ) : (
        <p className="field-note">
          WGS 84 lon/lat, per RFC 7946. Source, licence, vintage and export settings travel inside the
          file under <code>_provenance</code>.
        </p>
      )}

      {/*
        Stated up front rather than discovered afterwards. The desktop simplifies a whole
        export at once so that boundaries sharing an edge share the simplified arc; there is
        no way to do that here without mapshaper, and a per-feature approximation would open
        hairline seams between adjacent ridings.
      */}
      <p className="field-note">
        Full resolution — mobile does not simplify. Use the desktop app when a set needs thinning
        without opening seams between neighbours.
      </p>

      <button type="button" className="primary" onClick={() => void run()} disabled={busy || inputs.length === 0}>
        {busy ? 'Preparing…' : `Export ${inputs.length === 1 ? 'boundary' : `${inputs.length} boundaries`}`}
      </button>

      {error && <p className="msg err">{error}</p>}

      {done && (
        <div className="msg ok">
          <b>{done.file.filename}</b> — {formatBytes(done.file.bytes)}, {done.how}.
          {done.file.attribution && <div className="credit">Credit: {done.file.attribution}</div>}
          {done.file.licences.length > 0 && <div className="credit">Licence: {done.file.licences.join('; ')}</div>}
          {done.file.warnings.map((w) => (
            <div key={w} className="credit warn">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
