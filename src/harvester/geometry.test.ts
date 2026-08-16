import { describe, expect, it } from 'vitest';
import { HttpClient } from './http';
import { buildFesFilter, fetchFeatureGeometry, mergeGeometries } from './geometry';
import type { SourceRow } from '@shared/types';
import type { Geometry } from './normalize/crs';

function source(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    name: 'Test Source',
    kind: 'esri-rest',
    tier: 'A',
    endpoint: 'https://svc.test/MapServer',
    layer_id: '0',
    feature_type: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: 'v',
    licence: 'l',
    attribution: 'Test Attribution',
    name_fields: '[]',
    last_harvested_at: null,
    feature_count: null,
    status: 'ok',
    source_srid: 3978,
    verified_count: null,
    verified_at: '2026-08-16',
    notes: null,
    identity_field: null,
    ...over,
  };
}

const ONTARIO_SQUARE: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-80.2, 45.2],
      [-80.0, 45.2],
      [-80.0, 45.4],
      [-80.2, 45.4],
      [-80.2, 45.2],
    ],
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Records every URL requested, and answers from a queue of responses. */
function stub(responses: (() => Response)[]): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const impl = ((url: string) => {
    urls.push(url);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return Promise.resolve(next());
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const noSleep = () => Promise.resolve();

describe('mergeGeometries', () => {
  it('passes a single part through untouched', () => {
    expect(mergeGeometries([ONTARIO_SQUARE])).toBe(ONTARIO_SQUARE);
  });

  it('combines polygons into one MultiPolygon', () => {
    const merged = mergeGeometries([ONTARIO_SQUARE, ONTARIO_SQUARE]) as { type: string; coordinates: unknown[] };
    expect(merged.type).toBe('MultiPolygon');
    expect(merged.coordinates).toHaveLength(2);
  });

  it('flattens an existing MultiPolygon rather than nesting it', () => {
    const multi: Geometry = { type: 'MultiPolygon', coordinates: [ONTARIO_SQUARE.coordinates, ONTARIO_SQUARE.coordinates] };
    const merged = mergeGeometries([multi, ONTARIO_SQUARE]) as { coordinates: unknown[] };
    expect(merged.coordinates).toHaveLength(3);
  });

  it('refuses to mix polygons and lines', () => {
    const line: Geometry = { type: 'LineString', coordinates: [[-80, 45], [-79, 45]] };
    expect(() => mergeGeometries([ONTARIO_SQUARE, line])).toThrow(/refusing to merge/);
  });

  it('refuses an empty list', () => {
    expect(() => mergeGeometries([])).toThrow(/empty/);
  });
});

describe('buildFesFilter', () => {
  it('builds an OGC Filter Encoding equality test', () => {
    const xml = buildFesFilter('OBJECTID', '2935');
    expect(xml).toContain('<fes:ValueReference>OBJECTID</fes:ValueReference>');
    expect(xml).toContain('<fes:Literal>2935</fes:Literal>');
  });

  it('escapes XML metacharacters in the value', () => {
    expect(buildFesFilter('NAME', 'A & B <test>')).toContain('<fes:Literal>A &amp; B &lt;test&gt;</fes:Literal>');
  });
});

describe('fetchFeatureGeometry — ESRI', () => {
  it('asks for the feature by objectId at full resolution first', async () => {
    const { impl, urls } = stub([() => jsonResponse({ features: [{ geometry: ONTARIO_SQUARE }] })]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    const r = await fetchFeatureGeometry(http, source(), '42');
    expect(r.vertexCount).toBe(5);
    expect(r.generalisationDeg).toBeNull();

    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain('objectIds=42');
    expect(url).toContain('outSR=4326');
    expect(url).not.toContain('maxAllowableOffset');
  });

  it('uses a where clause on the identity field for a multipart layer', async () => {
    const { impl, urls } = stub([
      () => jsonResponse({ features: [{ geometry: ONTARIO_SQUARE }, { geometry: ONTARIO_SQUARE }] }),
    ]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    // One riding published as several polygons must come back as one merged feature.
    const r = await fetchFeatureGeometry(http, source({ identity_field: 'FED_NUM' }), '35084');
    expect(decodeURIComponent(urls[0]!)).toContain('where=FED_NUM=35084');
    expect(r.partCount).toBe(2);
    expect((r.geometry as { type: string }).type).toBe('MultiPolygon');
  });

  it('quotes a non-numeric identity value', async () => {
    const { impl, urls } = stub([() => jsonResponse({ features: [{ geometry: ONTARIO_SQUARE }] })]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await fetchFeatureGeometry(http, source({ identity_field: 'CSDUID' }), '3549021');
    expect(decodeURIComponent(urls[0]!)).toContain('where=CSDUID=3549021');

    const s2 = stub([() => jsonResponse({ features: [{ geometry: ONTARIO_SQUARE }] })]);
    const http2 = new HttpClient({ fetchImpl: s2.impl, sleepImpl: noSleep });
    await fetchFeatureGeometry(http2, source({ identity_field: 'CODE' }), 'AB-12');
    expect(decodeURIComponent(s2.urls[0]!)).toContain("where=CODE='AB-12'");
  });

  it('steps down the generalisation ladder when the service cannot serve full resolution', async () => {
    // StatCan answers a full-resolution Nunavut query with 500, every time, and only
    // succeeds once the geometry is generalised.
    let call = 0;
    const impl = (() => {
      call++;
      // maxAttempts defaults to 4, so the first resolution burns several attempts.
      return Promise.resolve(
        call <= 4 ? new Response('Error performing query operation', { status: 500 })
          : jsonResponse({ features: [{ geometry: ONTARIO_SQUARE }] }),
      );
    }) as unknown as typeof fetch;

    const notes: string[] = [];
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    const r = await fetchFeatureGeometry(http, source(), '13', (n) => notes.push(n));

    expect(r.generalisationDeg).toBe(0.0005);
    expect(notes[0]).toMatch(/generalised at 0.0005/);
  });

  it('does not step down for an error that generalisation cannot fix', async () => {
    // A 404 means the feature is not there; retrying coarser is pointless and would
    // hide the real problem behind three more failures.
    const { impl, urls } = stub([() => new Response('nope', { status: 404 })]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(fetchFeatureGeometry(http, source(), '42')).rejects.toThrow(/HTTP 404/);
    expect(urls.every((u) => !u.includes('maxAllowableOffset'))).toBe(true);
  });

  it('refuses geometry that is not in Canada', async () => {
    const paris: Geometry = {
      type: 'Polygon',
      coordinates: [[[2.2, 48.8], [2.4, 48.8], [2.4, 48.9], [2.2, 48.8]]],
    };
    const { impl } = stub([() => jsonResponse({ features: [{ geometry: paris }] })]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(fetchFeatureGeometry(http, source(), '1')).rejects.toThrow(/outside Canada/);
  });

  it('reports an empty response rather than caching nothing', async () => {
    const { impl } = stub([() => jsonResponse({ features: [] })]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(fetchFeatureGeometry(http, source(), '1')).rejects.toThrow(/returned no geometry/);
  });
});

describe('fetchFeatureGeometry — WFS', () => {
  const bcSource = source({
    kind: 'wfs',
    endpoint: 'https://openmaps.test/geo/pub/wfs',
    layer_id: 'pub:SOME_LAYER',
    source_srid: 3005,
  });

  it('filters on the id attribute the index used, not gml:id', async () => {
    // GeoServer mints synthetic gml:ids per request, so the fetcher recomputes the same
    // id attribute the harvester chose and filters on that.
    const describe = () =>
      jsonResponse({
        featureTypes: [
          {
            properties: [
              { name: 'ED_NAME', localType: 'string' },
              { name: 'SHAPE', localType: 'Geometry' },
              { name: 'OBJECTID', localType: 'number' },
            ],
          },
        ],
      });
    const feature = () =>
      jsonResponse({
        features: [{ id: 'X.fid-abc', geometry: { type: 'Polygon', coordinates: [[[1200000, 470000], [1200100, 470000], [1200100, 470100], [1200000, 470000]]] } }],
      });

    const { impl, urls } = stub([describe, feature]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    const r = await fetchFeatureGeometry(http, bcSource, '2935');

    expect(decodeURIComponent(urls[0]!)).toContain('DescribeFeatureType');
    const getFeature = decodeURIComponent(urls[1]!);
    expect(getFeature).toContain('<fes:ValueReference>OBJECTID</fes:ValueReference>');
    expect(getFeature).toContain('<fes:Literal>2935</fes:Literal>');
    expect(getFeature).toContain('srsName=EPSG:3005');

    // BC Albers in, lon/lat out.
    expect(r.vertexCount).toBe(4);
  });
});
