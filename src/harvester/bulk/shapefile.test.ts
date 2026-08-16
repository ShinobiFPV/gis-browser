import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideCrs,
  discoverLayers,
  dropDistantParts,
  readEncoding,
  selectLayer,
  ShapefileError,
} from './shapefile';
import { intersectsCanada } from '../normalize/crs';

/**
 * The WKT strings here are verbatim from the real archives, because the whole point of
 * decideCrs is coping with what publishers actually write. Neither carries an EPSG code.
 */

/** Elections Canada FED_CA_2023_EN.prj. Numerically EPSG:3347, despite the name. */
const FED_WKT =
  'PROJCS["PCS_Lambert_Conformal_Conic",GEOGCS["GCS_North_American_1983",' +
  'DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
  'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",6200000.0],' +
  'PARAMETER["False_Northing",3000000.0],PARAMETER["Central_Meridian",-91.86666666666666],' +
  'PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",77.0],' +
  'PARAMETER["Latitude_Of_Origin",63.390675],UNIT["Meter",1.0]]';

/** Natural Earth ne_10m_lakes.prj. Geographic, so no transform is needed. */
const NE_WKT =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** A point in the middle of the FED data, in its own projected metres. */
const FED_SAMPLE: [number, number] = [6338679, 3370939];

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gisb-shp-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('discoverLayers', () => {
  it('groups a shapefile with its sidecars', () => {
    const shp = write('lakes.shp', 'x');
    write('lakes.dbf', 'x');
    write('lakes.prj', NE_WKT);
    write('lakes.cpg', 'UTF-8');

    const [set] = discoverLayers([shp]);
    expect(set?.layer).toBe('lakes');
    expect(set?.dbf).toContain('lakes.dbf');
    expect(set?.prj).toContain('lakes.prj');
    expect(set?.cpg).toContain('lakes.cpg');
  });

  it('reports missing sidecars as null rather than guessing at paths', () => {
    const shp = write('bare.shp', 'x');
    const [set] = discoverLayers([shp]);
    expect(set?.dbf).toBeNull();
    expect(set?.prj).toBeNull();
    expect(set?.cpg).toBeNull();
  });

  it('never treats .shp.xml metadata as a layer', () => {
    const shp = write('meta.shp', 'x');
    write('meta.shp.xml', '<metadata/>');
    expect(discoverLayers([shp, join(dir, 'meta.shp.xml')])).toHaveLength(1);
  });
});

describe('selectLayer', () => {
  const a = { shp: 'a.shp', dbf: null, prj: null, cpg: null, layer: 'a' };
  const b = { shp: 'b.shp', dbf: null, prj: null, cpg: null, layer: 'b' };

  it('uses a single layer without needing a layer_id', () => {
    expect(selectLayer([a], null, 'src').layer).toBe('a');
  });

  it('refuses to guess between several layers', () => {
    expect(() => selectLayer([a, b], null, 'src')).toThrow(/Set layer_id/);
  });

  it('picks the named layer, case-insensitively', () => {
    expect(selectLayer([a, b], 'B', 'src').layer).toBe('b');
  });

  it('lists what is available when the name is wrong', () => {
    expect(() => selectLayer([a, b], 'c', 'src')).toThrow(/Available: a, b/);
  });

  it('fails loudly on an archive with no shapefile at all', () => {
    expect(() => selectLayer([], null, 'src')).toThrow(/No \.shp file found/);
  });
});

describe('readEncoding', () => {
  it('reads the declared codepage', () => {
    expect(readEncoding(write('a.cpg', 'UTF-8'))).toEqual({ encoding: 'utf-8', declared: true });
    expect(readEncoding(write('b.cpg', 'windows-1252'))).toEqual({ encoding: 'windows-1252', declared: true });
    expect(readEncoding(write('c.cpg', '65001'))).toEqual({ encoding: 'utf-8', declared: true });
    expect(readEncoding(write('d.cpg', '1252'))).toEqual({ encoding: 'windows-1252', declared: true });
  });

  it('falls back to UTF-8 and says the encoding was undeclared', () => {
    // StatCan's cartographic boundary archives ship no .cpg at all. Reading them as UTF-8
    // turns out to be right, but the caller has to know it was an assumption.
    expect(readEncoding(null)).toEqual({ encoding: 'utf-8', declared: false });
    expect(readEncoding(write('empty.cpg', '   '))).toEqual({ encoding: 'utf-8', declared: false });
    expect(readEncoding(join(dir, 'missing.cpg'))).toEqual({ encoding: 'utf-8', declared: false });
  });
});

describe('dropDistantParts', () => {
  const ring = (west: number, east: number): number[][] => [
    [west, 50],
    [east, 50],
    [east, 55],
    [west, 55],
    [west, 50],
  ];

  it('leaves a single-part geometry alone', () => {
    const poly = { type: 'Polygon', coordinates: [ring(-100, -90)] };
    expect(dropDistantParts(poly).dropped).toBe(0);
    expect(dropDistantParts(poly).geometry).toBe(poly);
  });

  it('leaves a multi-part geometry alone when every part is near Canada', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[ring(-100, -90)], [ring(-80, -70)]] };
    expect(dropDistantParts(multi).dropped).toBe(0);
  });

  it('drops outlying parts while keeping the ones that reach Canada', () => {
    // The United States: continental plus Alaska, minus Hawaii and American Samoa.
    const usa = {
      type: 'MultiPolygon',
      coordinates: [
        [ring(-125, -66)], // continental, borders Canada
        [ring(-168, -140)], // Alaska
        [ring(-160, -154)], // Hawaii -- nowhere near Canada
        [
          [
            [-171, -14],
            [-169, -14],
            [-169, -13],
            [-171, -13],
            [-171, -14],
          ],
        ], // American Samoa, south of the equator
      ],
    };
    const out = dropDistantParts(usa);
    expect(out.dropped).toBe(2);
    expect((out.geometry?.coordinates as unknown[]).length).toBe(2);
  });

  it('returns null when no part is near Canada, however the parts are spread', () => {
    /*
     * Russia, and the reason this returns null rather than passing the geometry back.
     * Natural Earth splits it at the antimeridian: parts across Siberia in positive
     * longitude, and parts in Chukotka at -180..-169. Not one is within 25 degrees of
     * Canada, but the union of their bounding boxes is -180..180, which overlaps Canada
     * and everywhere else. Rejecting on the whole-feature bbox therefore cannot work.
     */
    const russia = {
      type: 'MultiPolygon',
      coordinates: [[ring(20, 100)], [ring(100, 180)], [ring(-180, -169)]],
    };
    const out = dropDistantParts(russia);
    expect(out.geometry).toBeNull();
    expect(out.dropped).toBe(3);

    // The trap this avoids: the whole-feature bbox does look like it overlaps Canada.
    const wholeBbox = { minx: -180, maxx: 180, miny: 50, maxy: 55 };
    expect(intersectsCanada(wholeBbox)).toBe(true);
  });

  it('keeps a part whose own bbox straddles Canada even if it is wide', () => {
    const straddling = { type: 'MultiPolygon', coordinates: [[ring(-141, -52)], [ring(30, 40)]] };
    const out = dropDistantParts(straddling);
    expect(out.dropped).toBe(1);
    expect((out.geometry?.coordinates as unknown[]).length).toBe(1);
  });
});

describe('decideCrs', () => {
  it('reads the projection out of the .prj, EPSG code or not', () => {
    const decision = decideCrs(write('fed.prj', FED_WKT), 3347, FED_SAMPLE, 'FED');
    expect(decision.isGeographic).toBe(false);
    expect(decision.definition).toContain('Lambert_Conformal_Conic');
    expect(decision.disagreement).toBeNull();
  });

  it('recognises a geographic .prj so no transform is applied', () => {
    const decision = decideCrs(write('ne.prj', NE_WKT), 4326, [-80, 45], 'NE');
    expect(decision.isGeographic).toBe(true);
    expect(decision.disagreement).toBeNull();
  });

  it('catches a registry SRID that disagrees with the file', () => {
    // The real bug this exists for: the FED archive was seeded as EPSG:3978 but its .prj
    // is Statistics Canada Lambert. Reading it as 3978 puts Canada in the Atlantic.
    const decision = decideCrs(write('fed2.prj', FED_WKT), 3978, FED_SAMPLE, 'FED');
    expect(decision.disagreement).toMatch(/disagrees with the registry's EPSG:3978/);
    expect(decision.disagreement).toMatch(/Using the \.prj/);
    // The .prj still wins -- it is what the coordinates were actually written in.
    expect(decision.definition).toBe(FED_WKT);
  });

  it('compares CRS numerically, not by matching WKT text', () => {
    // Same projection, different spelling and parameter order. A textual comparison would
    // call these different; transforming a point with each shows they are the same.
    const equivalent =
      'PROJCS["Statistics Canada Lambert",GEOGCS["NAD83",DATUM["North_American_Datum_1983",' +
      'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
      'PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",63.390675],' +
      'PARAMETER["central_meridian",-91.8666666666667],PARAMETER["standard_parallel_1",49],' +
      'PARAMETER["standard_parallel_2",77],PARAMETER["false_easting",6200000],' +
      'PARAMETER["false_northing",3000000],UNIT["metre",1]]';
    const decision = decideCrs(write('equiv.prj', equivalent), 3347, FED_SAMPLE, 'X');
    expect(decision.disagreement).toBeNull();
  });

  it('falls back to the registry when the archive has no .prj', () => {
    const decision = decideCrs(null, 4326, [-80, 45], 'X');
    expect(decision.definition).toBe('EPSG:4326');
    expect(decision.description).toContain('from the registry');
    expect(decision.isGeographic).toBe(true);
  });

  it('refuses to guess when there is neither a .prj nor a registry SRID', () => {
    expect(() => decideCrs(null, null, [0, 0], 'X')).toThrow(/no way to know what its coordinates mean/);
  });

  it('reports an unreadable .prj rather than silently treating it as lon/lat', () => {
    expect(() => decideCrs(write('junk.prj', 'this is not WKT at all'), null, [0, 0], 'X')).toThrow(
      ShapefileError,
    );
  });
});
