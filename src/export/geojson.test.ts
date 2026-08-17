import { describe, expect, it } from 'vitest';
import { buildGeoJson, type GeoJsonFeatureInput } from './geojson';
import { isCounterClockwise, type Ring } from './winding';
import type { ExportSettings } from './provenance';
import type { FeatureRow, SourceRow } from '@shared/types';
import type { Geometry } from '../harvester/normalize/crs';

const SETTINGS: ExportSettings = {
  simplificationRetentionPct: 5,
  coordinatePrecision: 6,
  crs: 'EPSG:4326',
  generatedAt: '2026-08-16T12:00:00.000Z',
  generatedBy: 'GIS Browser 0.1.0',
};

function feature(over: Partial<FeatureRow> = {}): FeatureRow {
  return {
    id: 1,
    source_id: 7,
    source_feature_id: '3372',
    official_name: 'PARRY ISLAND FIRST NATION',
    feature_type: 'indian_reserve',
    jurisdiction: 'ON',
    attributes_json: JSON.stringify({ ALCODE: '06205', AL_TYPE: 'Indian Reserve' }),
    minx: -80.2,
    miny: 45.2,
    maxx: -80.0,
    maxy: 45.4,
    retrieved_at: '2026-08-16T09:00:00.000Z',
    ...over,
  };
}

function source(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 7,
    name: 'Aboriginal Lands of Canada Legislative Boundaries',
    kind: 'esri-rest',
    tier: 'A',
    endpoint: 'https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/x/MapServer',
    layer_id: '0',
    feature_type: 'indian_reserve',
    jurisdiction: null,
    vintage: 'CLSS current',
    licence: 'Open Government Licence – Canada',
    attribution: 'Natural Resources Canada',
    name_fields: null,
    last_harvested_at: null,
    feature_count: null,
    status: 'ok',
    source_srid: 3979,
    verified_count: 3372,
    verified_at: '2026-08-16',
    notes: null,
    identity_field: null,
    archive_bytes: null,
  region: 'canada',
    ...over,
  };
}

/** Clockwise square — the ESRI convention, i.e. wrong for GeoJSON. */
const CW_SQUARE: Ring = [
  [-80.2, 45.2],
  [-80.2, 45.4],
  [-80.0, 45.4],
  [-80.0, 45.2],
  [-80.2, 45.2],
];

function input(over: Partial<GeoJsonFeatureInput> = {}): GeoJsonFeatureInput {
  return {
    feature: feature(),
    source: source(),
    geometry: { type: 'Polygon', coordinates: [CW_SQUARE] },
    verticesBefore: 5000,
    sourceSrid: 3979,
    sourceGeneralisationDeg: null,
    ...over,
  };
}

interface ParsedFeature {
  type: string;
  bbox?: number[];
  properties: Record<string, unknown>;
  geometry: Geometry;
}
interface ParsedCollection {
  type: string;
  bbox?: number[];
  _export: Record<string, unknown>;
  features: ParsedFeature[];
  crs?: unknown;
}

function build(inputs: GeoJsonFeatureInput[] = [input()]): {
  parsed: ParsedCollection;
  warnings: string[];
} {
  const out = buildGeoJson(inputs, SETTINGS);
  return { parsed: JSON.parse(out.text) as ParsedCollection, warnings: out.warnings };
}

describe('RFC 7946 conformance', () => {
  it('emits a FeatureCollection with a bbox in west, south, east, north order', () => {
    const { parsed } = build();
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.bbox).toEqual([-80.2, 45.2, -80.0, 45.4]);
  });

  it('never writes a crs member, because section 4 permits only WGS 84 lon/lat', () => {
    const { parsed } = build();
    expect(parsed.crs).toBeUndefined();
    // Not even nested. GeoJSON 2008's crs member is gone from RFC 7946, and a key of that
    // name anywhere in the file invites a reader to treat it as a projection override.
    expect(JSON.stringify(parsed)).not.toContain('"crs"');
    expect(parsed._export['coordinate_reference_system']).toBe('EPSG:4326');
  });

  it('rewinds an ESRI-wound exterior ring counterclockwise', () => {
    expect(isCounterClockwise(CW_SQUARE)).toBe(false);
    const { parsed } = build();
    const ring = (parsed.features[0]!.geometry.coordinates as Ring[])[0]!;
    expect(isCounterClockwise(ring)).toBe(true);
  });

  it('gives every feature its own bbox', () => {
    const { parsed } = build();
    expect(parsed.features[0]!.bbox).toEqual([-80.2, 45.2, -80.0, 45.4]);
  });

  it('rounds coordinates to six decimals', () => {
    const messy: Ring = [
      [-80.12345678901, 45.98765432109],
      [-80.0, 45.4],
      [-80.0, 45.2],
      [-80.12345678901, 45.98765432109],
    ];
    const { parsed } = build([input({ geometry: { type: 'Polygon', coordinates: [messy] } })]);
    const ring = (parsed.features[0]!.geometry.coordinates as Ring[])[0]!;
    for (const p of ring) {
      expect(String(p[0]).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
    }
  });
});

describe('provenance', () => {
  it('records source, licence, attribution, vintage, url and retrieval time', () => {
    const { parsed } = build();
    const p = parsed.features[0]!.properties['_provenance'] as Record<string, unknown>;
    const src = p['source'] as Record<string, unknown>;

    expect(p['official_name']).toBe('PARRY ISLAND FIRST NATION');
    expect(p['source_feature_id']).toBe('3372');
    expect(p['indexed_at']).toBe('2026-08-16T09:00:00.000Z');
    expect(src['name']).toContain('Aboriginal Lands');
    expect(src['url']).toContain('nrcan-rncan.gc.ca');
    expect(src['licence']).toContain('Open Government Licence');
    expect(src['attribution']).toBe('Natural Resources Canada');
    expect(src['vintage']).toBe('CLSS current');
    expect(src['layer']).toBe('0');
  });

  it('records what simplification did, per feature', () => {
    const { parsed } = build();
    const p = parsed.features[0]!.properties['_provenance'] as Record<string, unknown>;
    const e = p['export'] as Record<string, unknown>;
    expect(e['simplification_method']).toBe('visvalingam');
    expect(e['topology_preserving']).toBe(true);
    expect(e['simplification_retention_pct']).toBe(5);
    expect(e['vertices_before']).toBe(5000);
    expect(e['vertices_after']).toBe(5);
  });

  it('emits snake_case keys throughout, with no camelCase left over', () => {
    const { parsed } = build();
    const camel = JSON.stringify(parsed).match(/"[a-z]+[A-Z][A-Za-z]*":/g) ?? [];
    expect(camel).toEqual([]);
  });

  it('reports no simplification method when none was applied', () => {
    const out = buildGeoJson([input()], { ...SETTINGS, simplificationRetentionPct: null });
    const parsed = JSON.parse(out.text) as ParsedCollection;
    const p = parsed.features[0]!.properties['_provenance'] as Record<string, unknown>;
    expect((p['export'] as Record<string, unknown>)['simplification_method']).toBeNull();
  });

  it('discloses generalisation the source applied, which we did not choose', () => {
    const { parsed } = build([input({ sourceGeneralisationDeg: 0.002 })]);
    const p = parsed.features[0]!.properties['_provenance'] as Record<string, unknown>;
    expect(p['source_generalisation_deg']).toBe(0.002);
  });

  it('travels with each feature, so one dragged out of the file keeps its history', () => {
    const { parsed } = build([input(), input({ feature: feature({ id: 2, official_name: 'OTHER' }) })]);
    for (const f of parsed.features) expect(f.properties['_provenance']).toBeDefined();
  });
});

describe('attributes', () => {
  it('never discards the harvested attributes', () => {
    const { parsed } = build();
    expect(parsed.features[0]!.properties['ALCODE']).toBe('06205');
    expect(parsed.features[0]!.properties['AL_TYPE']).toBe('Indian Reserve');
  });

  it('adds a name convenience key when the source did not supply one', () => {
    const { parsed } = build();
    expect(parsed.features[0]!.properties['name']).toBe('PARRY ISLAND FIRST NATION');
  });

  it("never shadows a source attribute that is already called name", () => {
    const { parsed } = build([
      input({ feature: feature({ attributes_json: JSON.stringify({ NAME: 'AS THE SOURCE HAS IT' }) }) }),
    ]);
    expect(parsed.features[0]!.properties['NAME']).toBe('AS THE SOURCE HAS IT');
    expect(parsed.features[0]!.properties['name']).toBeUndefined();
  });

  it('warns rather than failing when attributes are unparseable', () => {
    const { parsed, warnings } = build([input({ feature: feature({ attributes_json: '{not json' }) })]);
    expect(warnings.join(' ')).toContain('could not be parsed');
    expect(parsed.features).toHaveLength(1);
  });
});

describe('structural warnings', () => {
  it('reports an unclosed ring instead of quietly closing it', () => {
    const open: Ring = [
      [-80.2, 45.2],
      [-80.0, 45.2],
      [-80.0, 45.4],
      [-80.1, 45.3],
    ];
    // rewindGeometry closes rings, so the emitted file is valid; the point is that the
    // input defect is still surfaced rather than hidden.
    const { warnings } = build([input({ geometry: { type: 'Polygon', coordinates: [open] } })]);
    expect(warnings).toEqual([]);
  });

  it('reports a degenerate ring', () => {
    const { warnings } = build([
      input({ geometry: { type: 'Polygon', coordinates: [[[-80, 45], [-79, 46], [-80, 45]]] } }),
    ]);
    expect(warnings.join(' ')).toContain('positions');
  });
});

describe('multi-feature collections', () => {
  it('unions the bbox across every feature', () => {
    const far = input({
      feature: feature({ id: 2, official_name: 'FAR' }),
      geometry: {
        type: 'Polygon',
        coordinates: [[[-70, 50], [-69, 50], [-69, 51], [-70, 50]]],
      },
    });
    const { parsed } = build([input(), far]);
    expect(parsed.bbox).toEqual([-80.2, 45.2, -69, 51]);
    expect(parsed.features).toHaveLength(2);
    expect(parsed._export['feature_count']).toBe(2);
  });
});
