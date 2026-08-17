import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, parseExtent, parseSrid, toDataset } from './arcgis-hub';
import { classifyResource } from './ckan';
import { splitEsriUrl } from '../discovery/validate';
import { interleaveByGroup, normaliseEndpoint } from '../discovery/run-discovery';
import type { DiscoveredCandidate } from '../discovery/classify';

describe('ArcGIS Hub parsing', () => {
  it('caps the page size at what the API actually allows', () => {
    // Verified against the live API, which answers page[size]=500 with
    // "exceeds the maximum page size limit of 250". The brief expected 100; 101 works.
    expect(MAX_PAGE_SIZE).toBe(250);
  });

  it('reads a Hub envelope extent', () => {
    expect(
      parseExtent({ type: 'envelope', coordinates: [[-69.3136, 46.5447], [-50.1554, 60.4691]] }),
    ).toEqual({ minLon: -69.3136, minLat: 46.5447, maxLon: -50.1554, maxLat: 60.4691 });
  });

  it('discards a world-sized extent at the boundary rather than downstream', () => {
    expect(parseExtent({ type: 'envelope', coordinates: [[-179.23, -14.6], [179.86, 71.44]] })).toBeNull();
  });

  it('shrugs off a malformed extent', () => {
    expect(parseExtent(null)).toBeNull();
    expect(parseExtent({ coordinates: [[1, 2]] })).toBeNull();
    expect(parseExtent({ coordinates: [['a', 'b'], [1, 2]] })).toBeNull();
  });

  it('prefers latestWkid, because ESRI reports Web Mercator as the deprecated 102100', () => {
    expect(parseSrid({ latestWkid: 3857, wkid: 102100 })).toBe(3857);
    expect(parseSrid({ wkid: 26917 })).toBe(26917);
    expect(parseSrid(undefined)).toBeNull();
  });

  it('maps a dataset row, stripping HTML out of the licence', () => {
    const d = toDataset({
      id: 'abc_0',
      attributes: {
        name: 'Yukon Electoral Districts',
        url: 'https://mapservices.gov.yk.ca/arcgis/rest/services/x/MapServer/75',
        source: 'Government of Yukon',
        type: 'Feature Layer',
        recordCount: 21,
        license: '<p>Some <a href="#">terms</a></p>',
        fieldNames: ['OBJECTID', 'ELECTORAL_DISTRICT_NAME'],
      },
    });
    expect(d?.name).toBe('Yukon Electoral Districts');
    expect(d?.recordCount).toBe(21);
    expect(d?.licence).toBe('Some terms');
    expect(d?.fieldNames).toContain('ELECTORAL_DISTRICT_NAME');
  });

  it('refuses a row with no id or no name', () => {
    expect(toDataset({ attributes: { name: 'x' } })).toBeNull();
    expect(toDataset({ id: 'a', attributes: {} })).toBeNull();
  });
});

describe('CKAN resource classification', () => {
  it('trusts the URL over the declared format', () => {
    // BC labels whole datasets "multiple"; plenty of publishers leave format blank.
    expect(
      classifyResource({
        id: '1',
        name: 'x',
        format: 'multiple',
        url: 'https://example.ca/arcgis/rest/services/Boundaries/FeatureServer/0',
        description: null,
      }),
    ).toBe('esri-rest');

    expect(
      classifyResource({ id: '1', name: 'x', format: '', url: 'https://example.ca/geo/pub/wfs?service=WFS', description: null }),
    ).toBe('wfs');

    expect(
      classifyResource({ id: '1', name: 'x', format: null, url: 'https://example.ca/data/boundaries.zip', description: null }),
    ).toBe('bulk-file');
  });

  it('falls back to the declared format when the URL says nothing', () => {
    expect(
      classifyResource({ id: '1', name: 'x', format: 'SHP', url: 'https://example.ca/download/12345', description: null }),
    ).toBe('bulk-file');
  });

  it('ignores resources that are not data', () => {
    const notData: [string, string][] = [
      ['PDF', 'https://example.ca/report.pdf'],
      ['HTML', 'https://example.ca/landing-page'],
      ['JPG', 'https://example.ca/map.jpg'],
    ];
    for (const [format, url] of notData) {
      expect(classifyResource({ id: '1', name: 'x', format, url, description: null })).toBeNull();
    }
    expect(classifyResource({ id: '1', name: 'x', format: 'SHP', url: null, description: null })).toBeNull();
  });
});

describe('splitEsriUrl', () => {
  it('separates the service from the layer index', () => {
    expect(splitEsriUrl('https://x/arcgis/rest/services/A/FeatureServer/0')).toEqual({
      endpoint: 'https://x/arcgis/rest/services/A/FeatureServer',
      layerId: '0',
    });
    expect(splitEsriUrl('https://x/arcgis/rest/services/A/MapServer/75')).toEqual({
      endpoint: 'https://x/arcgis/rest/services/A/MapServer',
      layerId: '75',
    });
  });

  it('assumes layer 0 for a bare service url', () => {
    expect(splitEsriUrl('https://x/arcgis/rest/services/A/FeatureServer')?.layerId).toBe('0');
  });

  it('rejects anything that is not an ESRI service', () => {
    expect(splitEsriUrl('https://example.ca/data.zip')).toBeNull();
    expect(splitEsriUrl('https://example.ca/geoserver/wfs')).toBeNull();
  });
});

describe('deduplication and fair scheduling', () => {
  it('normalises endpoints so a trailing slash is not a new source', () => {
    expect(normaliseEndpoint('https://X/FeatureServer/', '0')).toBe('https://x/featureserver/0');
    expect(normaliseEndpoint('https://x/FeatureServer', '0')).toBe('https://x/featureserver/0');
  });

  function candidate(publisher: string, title: string): DiscoveredCandidate {
    return {
      catalog: 'arcgis-hub',
      catalogId: title,
      title,
      endpoint: `https://x/${title}/FeatureServer/0`,
      kind: 'esri-rest',
      publisher,
      extent: null,
      recordCount: null,
      srid: null,
      fieldNames: [],
      licence: null,
      description: null,
      featureType: 'provincial_electoral_district',
      jurisdiction: 'BC',
      jurisdictionVia: 'title',
      nameFields: ['ED_NAME'],
      confidence: 0.75,
      concerns: [],
    };
  }

  it('stops one publisher monopolising the front of the queue', () => {
    /*
     * B.C.'s Map Hub publishes five near-identical redistribution layers. Left in place
     * they consumed a quarter of the validation budget and pushed the Government of
     * Yukon's territorial ridings -- the only source for that jurisdiction in the whole
     * result set -- off the end of the list.
     */
    const sorted = [
      candidate('B.C. Map Hub', 'bc1'),
      candidate('B.C. Map Hub', 'bc2'),
      candidate('B.C. Map Hub', 'bc3'),
      candidate('B.C. Map Hub', 'bc4'),
      candidate('Government of Yukon', 'yt1'),
    ];

    const out = interleaveByGroup(sorted);
    expect(out).toHaveLength(5);
    // Yukon's only candidate is now second, not last.
    expect(out[1]?.publisher).toBe('Government of Yukon');
    // Nothing is discarded.
    expect(new Set(out.map((c) => c.title))).toEqual(new Set(['bc1', 'bc2', 'bc3', 'bc4', 'yt1']));
  });

  it('preserves order within a group, so each still leads with its best', () => {
    const out = interleaveByGroup([candidate('A', 'a1'), candidate('A', 'a2'), candidate('A', 'a3')]);
    expect(out.map((c) => c.title)).toEqual(['a1', 'a2', 'a3']);
  });
});
