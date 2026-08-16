import { describe, expect, it } from 'vitest';
import { HttpClient } from '../http';
import {
  isSyntheticFid,
  pageFeatures,
  parseCapabilities,
  pickIdField,
  pickSortField,
  geometryPropertyOf,
  type WfsProperty,
} from './ogc-wfs';

const BC_PROPS: WfsProperty[] = [
  { name: 'ELECTORAL_DISTRICT_ID', localType: 'number' },
  { name: 'ED_ABBREVIATION', localType: 'string' },
  { name: 'ED_NAME', localType: 'string' },
  { name: 'SHAPE', localType: 'Geometry' },
  { name: 'OBJECTID', localType: 'number' },
];

const noSleep = () => Promise.resolve();

function stubFetch(pages: unknown[]): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const impl = ((url: string) => {
    urls.push(url);
    const body = pages[i++] ?? { type: 'FeatureCollection', features: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, urls };
}

async function collect(gen: AsyncGenerator<unknown[], void, void>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const page of gen) out.push(...page);
  return out;
}

describe('parseCapabilities', () => {
  const xml = `<wfs:WFS_Capabilities><FeatureTypeList>
    <FeatureType><Name>pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW</Name>
      <Title>BC Electoral Districts</Title><DefaultCRS>urn:ogc:def:crs:EPSG::3005</DefaultCRS></FeatureType>
    <FeatureType><Name>pub:OTHER</Name><Title>Other</Title><DefaultCRS>urn:ogc:def:crs:EPSG::4326</DefaultCRS></FeatureType>
  </FeatureTypeList></wfs:WFS_Capabilities>`;

  it('finds a type and reads its default CRS', () => {
    const m = parseCapabilities(xml, 'pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW');
    expect(m?.defaultCrsSrid).toBe(3005);
    expect(m?.title).toBe('BC Electoral Districts');
  });

  it('matches even when the workspace prefix differs', () => {
    expect(parseCapabilities(xml, 'WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW')).not.toBeNull();
  });

  it('returns null for a type that is not advertised', () => {
    expect(parseCapabilities(xml, 'pub:NOPE')).toBeNull();
  });
});

describe('field selection', () => {
  it('sorts and identifies on OBJECTID when present', () => {
    expect(pickSortField(BC_PROPS)).toBe('OBJECTID');
    expect(pickIdField(BC_PROPS)).toBe('OBJECTID');
  });

  it('falls back to another id-shaped attribute', () => {
    const props = BC_PROPS.filter((p) => p.name !== 'OBJECTID');
    expect(pickIdField(props)).toBe('ELECTORAL_DISTRICT_ID');
  });

  it('reports no identity when the schema has none, rather than inventing one', () => {
    const props: WfsProperty[] = [
      { name: 'NAME', localType: 'string' },
      { name: 'SHAPE', localType: 'Geometry' },
    ];
    expect(pickIdField(props)).toBeNull();
    // A sort field is still required for paging, so a plain scalar is acceptable there.
    expect(pickSortField(props)).toBe('NAME');
  });

  it('throws when there is nothing at all to sort on', () => {
    expect(() => pickSortField([{ name: 'SHAPE', localType: 'Geometry' }])).toThrow(/No sortable attribute/);
  });

  it('locates the geometry property', () => {
    expect(geometryPropertyOf(BC_PROPS)).toBe('SHAPE');
  });
});

describe('synthetic feature ids', () => {
  it('recognises GeoServer synthetic ids', () => {
    expect(isSyntheticFid('WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW.fid-2facf063_1a00bca33b3_-7451')).toBe(true);
    expect(isSyntheticFid('WHSE_ADMIN_BOUNDARIES.ADM_INDIAN_RESERVES_BANDS_SP.629437')).toBe(false);
  });

  it('keys on the id attribute rather than the churning gml:id', async () => {
    // The same 2 features fetched twice, with different synthetic gml ids each time --
    // exactly what GeoServer does for a view with no primary key.
    const page = (fidSuffix: string) => ({
      features: [
        {
          id: `X.fid-${fidSuffix}-1`,
          properties: { OBJECTID: 101, ED_NAME: 'Vancouver-Point Grey' },
          geometry: { type: 'Point', coordinates: [1200000, 470000] },
        },
      ],
    });
    for (const suffix of ['aaa', 'bbb']) {
      const { impl } = stubFetch([page(suffix)]);
      const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
      const rows = (await collect(
        pageFeatures(http, {
          endpoint: 'https://bc.test/wfs',
          typeName: 'X',
          requestSrid: 3005,
          nameFields: ['ED_NAME'],
          sortField: 'OBJECTID',
          geometryField: 'SHAPE',
          idField: 'OBJECTID',
        }),
      )) as { sourceFeatureId: string }[];
      // Stable across both fetches, so a re-harvest updates instead of duplicating.
      expect(rows[0]?.sourceFeatureId).toBe('101');
    }
  });

  it('refuses to harvest when there is no id attribute and the server issues synthetic ids', async () => {
    const { impl } = stubFetch([
      {
        features: [
          { id: 'X.fid-2facf063_1a00bca33b3_-7451', properties: { NAME: 'Somewhere' }, geometry: null },
        ],
      },
    ]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(
      collect(
        pageFeatures(http, {
          endpoint: 'https://bc.test/wfs',
          typeName: 'X',
          requestSrid: 3005,
          nameFields: ['NAME'],
          sortField: 'NAME',
          geometryField: null,
          idField: null,
        }),
      ),
    ).rejects.toThrow(/would duplicate every feature/);
  });
});

describe('paging request shape', () => {
  it('always sends sortBy, and limits propertyName to what indexing needs', async () => {
    const { impl, urls } = stubFetch([{ features: [] }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await collect(
      pageFeatures(http, {
        endpoint: 'https://bc.test/wfs',
        typeName: 'X',
        requestSrid: 3005,
        nameFields: ['ED_NAME'],
        sortField: 'OBJECTID',
        geometryField: 'SHAPE',
        idField: 'OBJECTID',
      }),
    );
    const url = decodeURIComponent(urls[0]!);
    // GeoServer refuses startIndex paging without a stable sort.
    expect(url).toContain('sortBy=OBJECTID');
    expect(url).toContain('startIndex=0');
    expect(url).toContain('propertyName=OBJECTID,ED_NAME,SHAPE');
    expect(url).toContain('srsName=EPSG:3005');
  });

  it('reprojects the native CRS to lon/lat for the bbox', async () => {
    const { impl } = stubFetch([
      {
        features: [
          {
            id: '1',
            properties: { OBJECTID: 1, ED_NAME: 'Test' },
            // BC Albers coordinates; must come out as Canadian lon/lat.
            geometry: { type: 'Point', coordinates: [1000000, 0] },
          },
        ],
      },
    ]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    const rows = (await collect(
      pageFeatures(http, {
        endpoint: 'https://bc.test/wfs',
        typeName: 'X',
        requestSrid: 3005,
        nameFields: ['ED_NAME'],
        sortField: 'OBJECTID',
        geometryField: 'SHAPE',
        idField: 'OBJECTID',
      }),
    )) as { bbox: { minx: number; miny: number } | null }[];
    expect(rows[0]?.bbox?.minx).toBeCloseTo(-126, 2);
    expect(rows[0]?.bbox?.miny).toBeCloseTo(45, 2);
  });
});
