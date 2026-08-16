import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, Candidate } from '@shared/types';
import type { ExportFormat, ExportProgress, ExportRequest, ExportResult, GeometryResult } from '@shared/ipc';
import { DEFAULT_SVG_SRID, SVG_PROJECTIONS } from '@shared/projections';

interface Props {
  /** The previewed boundary. Exported when nothing is explicitly marked. */
  candidate: Candidate | null;
  /** Ticked in the search pane for a multi-feature export. */
  marked: Candidate[];
  geometry: GeometryResult | null;
  settings: AppSettings | null;
  onSettingsChanged: () => void;
}

/** Common broadcast canvases, plus whatever the artist types. */
const PRESETS = [
  { label: 'HD 1920x1080', width: 1920, height: 1080 },
  { label: 'UHD 3840x2160', width: 3840, height: 2160 },
  { label: 'Square 1080', width: 1080, height: 1080 },
  { label: 'Vertical 1080x1920', width: 1080, height: 1920 },
];

export function ExportPane({ candidate, marked, geometry, settings, onSettingsChanged }: Props): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('geojson');
  const [srid, setSrid] = useState(DEFAULT_SVG_SRID);
  const [retention, setRetention] = useState(5);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [padding, setPadding] = useState(40);

  const [preview, setPreview] = useState<ExportResult | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [done, setDone] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Marked features win; otherwise the one being previewed. Never both.
  const targets = marked.length > 0 ? marked : candidate ? [candidate] : [];
  const featureIds = targets.map((t) => t.featureId);
  const key = `${featureIds.join(',')}|${format}|${retention}|${srid}|${width}|${height}|${padding}`;

  const request = useCallback(
    (previewOnly: boolean): ExportRequest => ({
      featureIds,
      format,
      retentionPct: retention,
      srid,
      width,
      height,
      padding,
      previewOnly,
    }),
    [featureIds, format, retention, srid, width, height, padding],
  );

  useEffect(() => {
    const off = window.gis.onExportProgress(setProgress);
    return off;
  }, []);

  /**
   * The before/after vertex readout runs the real simplification.
   *
   * A linear estimate would be wrong: topology-preserving Visvalingam works on shared
   * arcs, so it does not hit the requested percentage, and the figure an artist uses to
   * decide whether a shape is still usable has to be the actual one. Geometry is cached
   * after the first fetch, so repeated slider moves cost only the simplify pass.
   */
  const generation = useRef(0);
  useEffect(() => {
    if (featureIds.length === 0) {
      setPreview(null);
      return;
    }
    const mine = ++generation.current;
    const timer = setTimeout(() => {
      setMeasuring(true);
      window.gis
        .exportPreview(request(true))
        .then((r) => {
          if (mine === generation.current) {
            setPreview(r);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (mine === generation.current) {
            setPreview(null);
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (mine === generation.current) setMeasuring(false);
        });
    }, 300);

    return () => clearTimeout(timer);
    // `key` collapses every input that changes the measurement into one dependency.

  }, [key]);

  async function exportNow(): Promise<void> {
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      setDone(await window.gis.exportRun(request(false)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const attribution = preview?.attribution ?? geometry?.attribution ?? candidate?.attribution ?? '';
  const warnings = done?.warnings ?? preview?.warnings ?? [];
  const nothingSelected = targets.length === 0;

  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">
        Export
        {targets.length > 1 && <span className="hint">{targets.length} features, one file</span>}
      </div>

      <div className="pane-body" style={{ padding: 8 }}>
        {nothingSelected && (
          <div className="empty" style={{ paddingLeft: 0 }}>
            Pick a boundary to export it on its own, or tick several in the search results to
            write them into one file.
            <br />
            <br />
            A multi-feature export is simplified as a single topology, so boundaries that share
            a border keep sharing it — no hairline gaps along the seams.
          </div>
        )}

        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="geojson">GeoJSON — RFC 7946, EPSG:4326</option>
            <option value="svg">SVG — projected, Illustrator ready</option>
          </select>
        </label>

        {format === 'svg' && (
          <>
            <label className="field">
              <span>Projection</span>
              <select value={srid} onChange={(e) => setSrid(Number(e.target.value))}>
                {SVG_PROJECTIONS.map((p) => (
                  <option key={p.srid} value={p.srid} title={p.hint}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-note">{SVG_PROJECTIONS.find((p) => p.srid === srid)?.hint}</div>

            <label className="field">
              <span>Canvas</span>
              <select
                value={`${width}x${height}`}
                onChange={(e) => {
                  const p = PRESETS.find((x) => `${x.width}x${x.height}` === e.target.value);
                  if (p) {
                    setWidth(p.width);
                    setHeight(p.height);
                  }
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.label} value={`${p.width}x${p.height}`}>
                    {p.label}
                  </option>
                ))}
                {!PRESETS.some((p) => p.width === width && p.height === height) && (
                  <option value={`${width}x${height}`}>{`Custom ${width}x${height}`}</option>
                )}
              </select>
            </label>

            <label className="field">
              <span>Size and padding</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min={1} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
                <input type="number" min={1} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
                <input type="number" min={0} value={padding} onChange={(e) => setPadding(Number(e.target.value))} />
              </div>
            </label>
          </>
        )}

        <label className="field">
          <span>
            Simplification — {retention}% of vertices retained
            {retention === 100 && ' (none)'}
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={retention}
            style={{ width: '100%' }}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
        </label>

        <div className="readout">
          <span>
            before <b>{preview ? preview.verticesBefore.toString() : '—'}</b>
          </span>
          <span>
            after{' '}
            <b className={measuring ? 'dim' : ''}>
              {measuring ? '…' : preview ? preview.verticesAfter.toString() : '—'}
            </b>
          </span>
          {preview && preview.verticesBefore > 0 && !measuring && (
            <span className="dim">
              {Math.round((preview.verticesAfter / preview.verticesBefore) * 100)}% kept,{' '}
              {(preview.bytes / 1024).toFixed(0)} kB
            </span>
          )}
        </div>

        {/* Never silent: a lost hole, an unclosed ring, or generalisation the SOURCE
            applied all surface here before the file is written. */}
        {warnings.map((w, i) => (
          <div key={i} className="warn-line">
            {w}
          </div>
        ))}

        {error && <div className="warn-line error">{error}</div>}

        {running && progress && (
          <div className="progress-line">
            {progress.phase}
            {progress.total > 1 && ` ${progress.done}/${progress.total}`} — {progress.message}
          </div>
        )}

        {done?.path && (
          <div className="done-line">
            <div className="mono">{done.path}</div>
            <div>
              {done.featureCount} feature{done.featureCount === 1 ? '' : 's'},{' '}
              {(done.bytes / 1024).toFixed(0)} kB, {done.elapsedMs} ms
              <button className="link-button" onClick={() => void window.gis.exportReveal(done.path!)}>
                show in folder
              </button>
            </div>
            {done.licences.length > 1 && (
              <div className="warn-line">
                This file mixes {done.licences.length} licences: {done.licences.join(' | ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pane-footer">
        <label className="field">
          <span>
            On-air credit
            {attribution && (
              <button
                className="link-button"
                onClick={() => {
                  void navigator.clipboard.writeText(attribution);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            )}
          </span>
          <input
            type="text"
            readOnly
            value={attribution}
            placeholder="attribution appears once a boundary is selected"
          />
        </label>

        <div className="folder-line">
          <span className="dim">to</span>{' '}
          <span className="mono" title={settings?.exportFolder ?? ''}>
            {settings?.exportFolder ?? '…'}
          </span>
          <button
            className="link-button"
            onClick={() => void window.gis.exportSetFolder().then(onSettingsChanged)}
          >
            change
          </button>
        </div>

        <button className="primary" disabled={nothingSelected || running} onClick={() => void exportNow()}>
          {running
            ? 'Exporting…'
            : targets.length > 1
              ? `Export ${targets.length} as ${format === 'svg' ? 'SVG' : 'GeoJSON'}`
              : `Export ${format === 'svg' ? 'SVG' : 'GeoJSON'}`}
        </button>
      </div>
    </section>
  );
}
