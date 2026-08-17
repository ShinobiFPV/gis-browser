import { describe, expect, it } from 'vitest';
import type { Geometry } from '../../harvester/normalize/crs';
import type { MobileFeature } from './catalog';
import { buildExport, type ExportInput } from './export';

/**
 * The mobile export shim.
 *
 * The file FORMATS are already covered by export/geojson.test.ts and export/svg.test.ts,
 * and this deliberately does not re-test them. What is tested here is the join: the mobile
 * catalog holds a feature in a different shape from the database row the shared builders
 * read, and every field that widening gets wrong ends up in a provenance block that is
 * supposed to be the answer when a boundary is challenged after broadcast.
 */

const SQUARE: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-80, 45],
      [-79, 45],
      [-79, 46],
      [-80, 46],
      [-80, 45],
    ],
  ],
};

const FEATURE: MobileFeature = {
  id: 42,
  name: 'Parry Sound—Muskoka',
  featureType: 'federal_electoral_district',
  jurisdiction: 'CA-ON',
  sourceFeatureId: '47',
  bbox: [-80, 45, -79, 46],
  source: {
    id: 3,
    name: 'Federal Electoral Districts — 2025',
    kind: 'esri-rest',
    endpoint: 'https://example.test/fed/MapServer',
    layerId: '3',
    licence: 'Open Government Licence – Canada',
    attribution: 'Elections Canada',
    vintage: '2025 general election',
    srid: 3978,
    identityField: 'FED_NUM',
    verifiedAt: '2026-08-16',
  },
};

const INPUT: ExportInput = {
  feature: FEATURE,
  geometry: SQUARE,
  vertexCount: 5,
  generalisationDeg: null,
};

const INDEXED_AT = '2026-08-17';

interface Provenance {
  official_name: string;
  feature_type: string;
  jurisdiction: string | null;
  source_feature_id: string;
  source_srid: number | null;
  indexed_at: string;
  source_generalisation_deg: number | null;
  source: Record<string, unknown>;
  export: Record<string, unknown>;
}

function provenanceOf(text: string): Provenance {
  const parsed = JSON.parse(text) as {
    features: { properties: { _provenance: Provenance } }[];
  };
  return parsed.features[0]!.properties._provenance;
}

describe('buildExport — GeoJSON', () => {
  it('carries the whole provenance chain out of the mobile catalog', () => {
    const file = buildExport([INPUT], 'geojson', INDEXED_AT);
    const p = provenanceOf(file.text);

    expect(p.official_name).toBe('Parry Sound—Muskoka');
    expect(p.feature_type).toBe('federal_electoral_district');
    expect(p.jurisdiction).toBe('CA-ON');
    expect(p.source_feature_id).toBe('47');
    expect(p.source_srid).toBe(3978);
    expect(p.source).toMatchObject({
      name: 'Federal Electoral Districts — 2025',
      url: 'https://example.test/fed/MapServer',
      layer: '3',
      kind: 'esri-rest',
      tier: 'A',
      licence: 'Open Government Licence – Canada',
      attribution: 'Elections Canada',
      vintage: '2025 general election',
      endpoint_verified_at: '2026-08-16',
    });
  });

  it('dates the record from the index build, which is when it was actually true', () => {
    expect(provenanceOf(buildExport([INPUT], 'geojson', INDEXED_AT).text).indexed_at).toBe(INDEXED_AT);
  });

  it('declares no simplification, because mobile does none', () => {
    const p = provenanceOf(buildExport([INPUT], 'geojson', INDEXED_AT).text);
    expect(p.export['simplification_retention_pct']).toBeNull();
    expect(p.export['simplification_method']).toBeNull();
    expect(p.export['vertices_before']).toBe(p.export['vertices_after']);
    expect(p.export['generated_by']).toMatch(/^GIS Browser Mobile /);
  });

  it('discloses source-side generalisation, which is not ours to undo', () => {
    const generalised = buildExport([{ ...INPUT, generalisationDeg: 0.002 }], 'geojson', INDEXED_AT);
    expect(provenanceOf(generalised.text).source_generalisation_deg).toBe(0.002);
  });

  it('names the file after the boundary, not after the export', () => {
    const file = buildExport([INPUT], 'geojson', INDEXED_AT);
    expect(file.filename).toMatch(/^parry-sound-muskoka_federal-electoral-district_\d{4}-\d{2}-\d{2}\.geojson$/);
    expect(file.mimeType).toBe('application/geo+json');
  });

  it('describes a multi-feature export by its shape rather than listing every name', () => {
    const other: ExportInput = { ...INPUT, feature: { ...FEATURE, id: 43, name: 'Nipissing—Timiskaming' } };
    const file = buildExport([INPUT, other], 'geojson', INDEXED_AT);
    expect(file.filename).toMatch(/^2-federal-electoral-districts_ca-on_\d{4}-\d{2}-\d{2}\.geojson$/);
  });

  it('reports the credit line and licence for the sources it actually used', () => {
    const file = buildExport([INPUT], 'geojson', INDEXED_AT);
    expect(file.attribution).toBe('Elections Canada');
    expect(file.licences).toEqual(['Open Government Licence – Canada']);
  });
});

describe('buildExport — SVG', () => {
  it('projects rather than drawing raw lon/lat', () => {
    const file = buildExport([INPUT], 'svg', INDEXED_AT, { srid: 3347 });
    expect(file.mimeType).toBe('image/svg+xml');
    expect(file.filename).toMatch(/\.svg$/);
    expect(file.text).toContain('EPSG:3347');
    expect(file.text).toContain('<title>Parry Sound—Muskoka</title>');
    // A path, not a bare viewBox: an SVG that projected nothing has nothing to draw.
    expect(file.text).toMatch(/<path d="M[-\d.,]/);
  });

  it('refuses a projection that is not on offer, rather than guessing one', () => {
    expect(() => buildExport([INPUT], 'svg', INDEXED_AT, { srid: 9999 })).toThrow(/not one of the offered/);
  });
});

describe('buildExport — nothing to export', () => {
  it('says so instead of writing an empty file', () => {
    expect(() => buildExport([], 'geojson', INDEXED_AT)).toThrow(/Nothing selected/);
  });
});
