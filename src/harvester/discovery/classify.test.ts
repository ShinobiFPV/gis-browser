import { describe, expect, it } from 'vitest';
import {
  assess,
  classifyFeatureType,
  classifyPublisher,
  FEDERAL_SEATS,
  inferJurisdiction,
  isGovernmentHost,
  pickNameFields,
} from './classify';
import { jurisdictionForExtent, sanitiseExtent } from '@shared/provinces';

/**
 * Every case here is a real one, taken from what the crawlers actually returned. The
 * classifier's job is to survive ArcGIS Hub, so the tests are made of ArcGIS Hub.
 */

describe('pickNameFields', () => {
  it('finds the name field in real layers', () => {
    expect(pickNameFields(['FID', 'DIST_NAME', 'Shape__Area', 'GlobalID'])).toEqual(['DIST_NAME']);
    expect(pickNameFields(['OBJECTID', 'CON_NAME', 'CON_NUM'])).toEqual(['CON_NAME']);
    expect(pickNameFields(['OBJECTID', 'ED_NAME', 'EDName2017'])).toContain('ED_NAME');
  });

  it('drops display aliases, which are not queryable fields', () => {
    // Hub interleaves field names with their aliases. Querying "Official Name" is a 400.
    const hubFields = ['OBJECTID', 'ED_ID', 'Electoral District ID', 'NAME', 'Official Name', 'FRENCH_NAME'];
    const picked = pickNameFields(hubFields);
    expect(picked).toContain('NAME');
    expect(picked.every((f) => !/\s/.test(f))).toBe(true);
  });

  it('never proposes a system or geometry field', () => {
    expect(pickNameFields(['OBJECTID', 'GlobalID', 'Shape__Area', 'Shape__Length', 'CreationDate'])).toEqual([]);
    expect(pickNameFields(['SHAPE.STArea()', 'SHAPE.STLength()', 'SHAPE'])).toEqual([]);
  });

  it('returns nothing when no field could hold a name', () => {
    expect(pickNameFields(['OBJECTID', 'POP2021', 'AREA_KM2'])).toEqual([]);
  });
});

describe('classifyFeatureType', () => {
  it('prefers the longest phrase, so provincial is not read as federal', () => {
    expect(classifyFeatureType('Provincial Electoral Districts')).toBe('provincial_electoral_district');
    expect(classifyFeatureType('Federal Electoral Districts')).toBe('federal_electoral_district');
  });

  it('knows what the provinces call their own ridings', () => {
    expect(classifyFeatureType('Provincial Constituencies')).toBe('provincial_electoral_district');
    expect(classifyFeatureType('Current Alberta Electoral Divisions')).toBe('provincial_electoral_district');
    expect(classifyFeatureType('Saskatchewan 2016ConstituencyBoundary')).toBe('provincial_electoral_district');
  });

  it('ignores tags and description entirely', () => {
    /*
     * The Saskatchewan publisher whose tags broke this twice. Every layer in that account
     * carries the same tag cloud, so "Fishing Zones" was classified first as a health
     * region and then as an electoral district while its tags never changed.
     */
    expect(classifyFeatureType('Fishing Zones', 'health region constituency boundary', 'tagged alike')).toBeNull();
  });

  it('returns null rather than guessing at an unrecognisable title', () => {
    expect(classifyFeatureType('Layer PJ1')).toBeNull();
    expect(classifyFeatureType('')).toBeNull();
  });
});

describe('inferJurisdiction', () => {
  const ontario = { minLon: -95, minLat: 42, maxLon: -75, maxLat: 56 };

  it('reads the province out of the title first', () => {
    expect(inferJurisdiction('Current Alberta Electoral Divisions', null, ontario)).toEqual({
      jurisdiction: 'AB',
      via: 'title',
    });
  });

  it('falls back to the publisher', () => {
    expect(inferJurisdiction('Electoral Districts', 'Government of Newfoundland and Labrador', null)).toEqual({
      jurisdiction: 'NL',
      via: 'publisher',
    });
  });

  it('falls back to the extent only when the words say nothing', () => {
    expect(inferJurisdiction('Electoral Districts', 'Some Org', ontario)).toEqual({
      jurisdiction: 'ON',
      via: 'extent',
    });
  });

  it('admits it does not know rather than picking the least-bad province', () => {
    // Half of North America. Reporting this as Nunavut -- which it did, because Nunavut
    // has the largest bounding box -- is a confident wrong answer.
    const northAmerica = { minLon: -134.75, minLat: 23.56, maxLon: -55.7, maxLat: 50.31 };
    expect(jurisdictionForExtent(northAmerica)).toBeNull();
    expect(inferJurisdiction('Electoral Districts', 'City and County of Durham, NC', northAmerica)).toEqual({
      jurisdiction: null,
      via: 'none',
    });
  });
});

describe('sanitiseExtent', () => {
  it('keeps a plausible Canadian extent', () => {
    expect(sanitiseExtent({ minLon: -141, minLat: 60, maxLon: -124, maxLat: 69 })).not.toBeNull();
    // Canada itself: about 89 by 43 degrees, comfortably inside the limits.
    expect(sanitiseExtent({ minLon: -141.5, minLat: 41, maxLon: -52, maxLat: 84 })).not.toBeNull();
  });

  it('rejects the world-sized default Hub publishes for so many layers', () => {
    expect(sanitiseExtent({ minLon: -179.23, minLat: -14.6, maxLon: 179.86, maxLat: 71.44 })).toBeNull();
    expect(sanitiseExtent({ minLon: -180, minLat: 36.27, maxLon: 180, maxLat: 89 })).toBeNull();
  });

  it('rejects degenerate and impossible boxes', () => {
    expect(sanitiseExtent({ minLon: -80, minLat: 45, maxLon: -80, maxLat: 45 })).toBeNull();
    expect(sanitiseExtent({ minLon: -200, minLat: 45, maxLon: -80, maxLat: 46 })).toBeNull();
    expect(sanitiseExtent(null)).toBeNull();
  });
});

describe('classifyPublisher', () => {
  it('recognises institutions', () => {
    expect(classifyPublisher('Government of Newfoundland and Labrador')).toBe('official');
    expect(classifyPublisher('Elections Alberta')).toBe('official');
    expect(classifyPublisher('The City of Kingston')).toBe('official');
  });

  it('recognises individual accounts', () => {
    expect(classifyPublisher('Bunwee16')).toBe('personal');
    expect(classifyPublisher('paulpeters')).toBe('personal');
    expect(classifyPublisher('rene.duplain@uottawa.ca')).toBe('personal');
  });

  it('lets a government host outrank the account that listed it', () => {
    // Saskatchewan's 61 constituencies are listed by "Bunwee16" but served by the
    // province's own GIS server. Judging the account alone demoted the best source
    // available for an entire province.
    expect(
      classifyPublisher('Bunwee16', 'https://gis.saskatchewan.ca/arcgis/rest/services/Administrative/MapServer/6'),
    ).toBe('official');
    expect(isGovernmentHost('https://mapservices.gov.yk.ca/arcgis/rest/services/x/MapServer/75')).toBe(true);
    expect(isGovernmentHost('https://services1.arcgis.com/abc/arcgis/rest/services/x/FeatureServer/0')).toBe(false);
    expect(isGovernmentHost('not a url')).toBe(false);
  });
});

describe('assess', () => {
  const base = {
    title: 'Provincial Electoral Districts',
    featureType: 'provincial_electoral_district' as const,
    jurisdiction: 'ON' as const,
    extent: { minLon: -95, minLat: 42, maxLon: -75, maxLat: 56 },
    recordCount: 124,
    nameFields: ['ED_NAME'],
    licence: 'Open Government Licence',
    publisher: 'Government of Ontario',
    jurisdictionVia: 'title' as const,
  };

  it('is content with a well-formed candidate', () => {
    const { confidence, concerns } = assess(base);
    expect(concerns).toEqual([]);
    expect(confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('catches a municipal extract wearing a jurisdiction-wide title', () => {
    // The City of Brampton's "Provincial Electoral Districts": 5 of Ontario's 124 ridings,
    // covering a fraction of a percent of the province.
    const { confidence, concerns } = assess({
      ...base,
      extent: { minLon: -79.8941, minLat: 43.5957, maxLon: -79.6214, maxLat: 43.856 },
      recordCount: 5,
      publisher: 'City of Brampton',
    });
    expect(concerns.join(' ')).toMatch(/Covers about 0\.\d% of ON/);
    expect(concerns.join(' ')).toMatch(/local extract/);
    // Must rank clearly below a clean candidate, which is what decides where the
    // validation budget goes and what a reviewer reads first.
    expect(confidence).toBeLessThan(assess(base).confidence - 0.3);
  });

  it('catches provincial ridings mislabelled federal, by counting them', () => {
    // Government of Yukon's "Yukon Electoral Districts": 21 features. Yukon has ONE
    // federal seat, so these are the territorial legislature's boundaries.
    const { concerns, confidence } = assess({
      ...base,
      title: 'Yukon Electoral Districts',
      featureType: 'federal_electoral_district',
      jurisdiction: 'YT',
      extent: { minLon: -141, minLat: 60, maxLon: -124, maxLat: 69 },
      recordCount: 21,
      publisher: 'Government of Yukon',
    });
    expect(concerns.join(' ')).toMatch(/YT, which has 1 federal seat/);
    expect(concerns.join(' ')).toMatch(/provincial or territorial ridings/);
    expect(confidence).toBeLessThan(0.7);
  });

  it('accepts a federal layer whose count matches its jurisdiction', () => {
    const { concerns } = assess({
      ...base,
      featureType: 'federal_electoral_district',
      jurisdiction: 'CA',
      extent: { minLon: -141, minLat: 41, maxLon: -52, maxLat: 84 },
      recordCount: 343,
    });
    expect(concerns.join(' ')).not.toMatch(/federal seat/);
  });

  it('flags a jurisdiction inferred from geography alone', () => {
    const { concerns } = assess({ ...base, jurisdictionVia: 'extent' });
    expect(concerns.join(' ')).toMatch(/inferred from the extent alone/);
  });

  it('flags a candidate with nothing that could serve as a name', () => {
    const { confidence, concerns } = assess({ ...base, nameFields: [] });
    expect(concerns.join(' ')).toMatch(/could not be searched for by name/);
    expect(confidence).toBeLessThan(assess(base).confidence - 0.3);
  });

  it('flags an individual publisher and rewards an official one', () => {
    const personal = assess({ ...base, publisher: 'paulpeters' });
    expect(personal.concerns.join(' ')).toMatch(/individual account/);
    expect(personal.confidence).toBeLessThan(assess(base).confidence);
  });

  it('always says when the licence is unusable', () => {
    for (const licence of [null, '', 'none', 'custom']) {
      expect(assess({ ...base, licence }).concerns.join(' ')).toMatch(/no usable licence/);
    }
  });
});

describe('FEDERAL_SEATS', () => {
  it('sums to the 343 seats of the 2023 representation order', () => {
    const provinces = Object.entries(FEDERAL_SEATS).filter(([k]) => k !== 'CA');
    expect(provinces.reduce((n, [, v]) => n + (v ?? 0), 0)).toBe(343);
    expect(FEDERAL_SEATS.CA).toBe(343);
  });
});
