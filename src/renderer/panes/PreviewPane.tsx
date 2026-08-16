import { useEffect, useRef, useState } from 'react';
import { MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Vite bundles maplibre's worker and hands us a relative asset URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Geometry as GeoJsonGeometry } from 'geojson';

/**
 * maplibre derives its worker URL from `import.meta.url` and gives up -- returning an
 * empty string -- unless the page was served over http(s). The app runs from file://, so
 * that empty URL resolves to index.html and the worker dies with a MIME type error, which
 * takes the whole map with it. Point it at the bundled worker explicitly instead.
 */
setWorkerUrl(maplibreWorkerUrl);
import type { Candidate } from '@shared/types';
import type { GeometryResult } from '@shared/ipc';

interface Props {
  candidate: Candidate | null;
  onGeometry?: (result: GeometryResult | null) => void;
}

/**
 * No basemap.
 *
 * An artist wants the boundary itself, not a Google-looking map behind it, and the
 * renderer's CSP forbids requests to any external host anyway. So the style is a flat
 * background plus our own GeoJSON, which also means the preview works with no internet.
 */
const EMPTY_STYLE: MapOptions['style'] = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#070a0e' } }],
};

const SRC = 'feature';

export function PreviewPane({ candidate, onGeometry }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  // Held in a ref so a parent that passes a fresh callback each render does not
  // retrigger the fetch effect and loop.
  const onGeometryRef = useRef(onGeometry);
  onGeometryRef.current = onGeometry;

  const [result, setResult] = useState<GeometryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One map for the life of the pane; only its data changes.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: EMPTY_STYLE,
      center: [-96, 60],
      zoom: 2.2,
      attributionControl: false,
      // The catalog is Canada-only, so a globe would mostly show ocean.
      renderWorldCopies: false,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'fill', type: 'fill', source: SRC, paint: { 'fill-color': '#4d9fff', 'fill-opacity': 0.18 } });
      map.addLayer({
        id: 'line',
        type: 'line',
        source: SRC,
        paint: { 'line-color': '#4d9fff', 'line-width': 1.4 },
      });
      setReady(true);
    });
    mapRef.current = map;

    // The pane is a flex child; maplibre needs a nudge when the window resizes.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Fetch geometry whenever the selection changes. A cache miss goes to the network,
  // which is why this has a visible loading state rather than an optimistic redraw.
  const featureId = candidate?.featureId ?? null;

  useEffect(() => {
    let cancelled = false;

    if (featureId === null) {
      setResult(null);
      setError(null);
      onGeometryRef.current?.(null);
      return;
    }

    setLoading(true);
    setError(null);

    void window.gis
      .geometryGet(featureId)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        onGeometryRef.current?.(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setResult(null);
        onGeometryRef.current?.(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [featureId]);

  // Push the geometry into the map once both it and the style are ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source: GeoJSONSource | undefined = map.getSource(SRC);
    if (!source) return;

    if (!result) {
      void source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    void source.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: result.geometry as GeoJsonGeometry }],
    });

    const bbox = result.bbox;
    if (bbox) {
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 40, duration: 400, maxZoom: 12 },
      );
    }
  }, [result, ready]);

  const vertices = result?.vertexCount ?? null;

  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">
        Preview
        {candidate && <span className="hint">{candidate.officialName}</span>}
      </div>

      <div className="pane-body" style={{ overflow: 'hidden' }}>
        <div className="map-shell">
          <div ref={containerRef} className="map" />
          {!candidate && <div className="map-overlay">Select a candidate to preview its boundary.</div>}
          {loading && <div className="map-overlay">Fetching geometry…</div>}
          {error && <div className="map-overlay error">{error}</div>}
          {result?.generalisationDeg != null && (
            <div className="map-badge warn" title="The service could not deliver this boundary at full resolution.">
              generalised at source · {result.generalisationDeg}°
            </div>
          )}
        </div>
      </div>

      <div className="pane-footer">
        <div className="readout">
          <span>
            vertices <b>{vertices === null ? '—' : vertices.toLocaleString()}</b>
          </span>
          <span>
            parts <b>{result ? result.partCount : '—'}</b>
          </span>
          <span>
            bbox{' '}
            <b className="mono">{result?.bbox ? result.bbox.map((n) => n.toFixed(3)).join(', ') : '—'}</b>
          </span>
          <span>
            source <b>{result ? (result.fromCache ? 'cache' : `network ${result.fetchMs}ms`) : '—'}</b>
          </span>
        </div>
      </div>
    </section>
  );
}
