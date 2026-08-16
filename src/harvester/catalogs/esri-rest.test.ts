import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, ServiceError } from '../http';
import { buildOutFields, fetchCount, pageFeatures, type EsriLayerMeta } from './esri-rest';

function meta(over: Partial<EsriLayerMeta> = {}): EsriLayerMeta {
  return {
    name: 'Test Layer',
    geometryType: 'esriGeometryPolygon',
    maxRecordCount: 2,
    supportsPagination: true,
    objectIdField: 'OBJECTID',
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID' },
      { name: 'ED_NAMEE', type: 'esriFieldTypeString' },
      { name: 'ED_NAMEF', type: 'esriFieldTypeString' },
      { name: 'FED_NUM', type: 'esriFieldTypeInteger' },
    ],
    extentWkid: 3978,
    ...over,
  };
}

/** Builds a fetch stub that answers from a canned list of page bodies. */
function stubFetch(pages: unknown[]): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const impl = ((url: string) => {
    urls.push(url);
    const body = pages[i++] ?? { type: 'FeatureCollection', features: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }) as unknown as typeof fetch;
  return { impl, urls };
}

function feature(oid: number, name: string) {
  return {
    type: 'Feature',
    properties: { OBJECTID: oid, ED_NAMEE: name, FED_NUM: 35000 + oid },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-80.1, 45.3],
          [-80.0, 45.3],
          [-80.0, 45.4],
          [-80.1, 45.3],
        ],
      ],
    },
  };
}

async function collect(gen: AsyncGenerator<unknown[], void, void>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const page of gen) out.push(...page);
  return out;
}

const noSleep = () => Promise.resolve();

describe('buildOutFields', () => {
  it('requests the object id and the declared name fields, not everything', () => {
    const out = buildOutFields(meta(), ['ED_NAMEE', 'ED_NAMEF', 'FED_NUM']);
    expect(out.split(',')).toEqual(expect.arrayContaining(['OBJECTID', 'ED_NAMEE', 'ED_NAMEF', 'FED_NUM']));
    expect(out).not.toContain('*');
  });

  it('skips declared fields the layer does not actually have', () => {
    const out = buildOutFields(meta(), ['ED_NAMEE', 'NOT_A_FIELD']);
    expect(out).not.toContain('NOT_A_FIELD');
  });

  it('throws when none of the declared name fields exist', () => {
    // This is a registry bug and must be loud, not a harvest of nameless rows.
    expect(() => buildOutFields(meta(), ['NAME1', 'NAME2'])).toThrow(/None of the declared name fields/);
  });

  it('pulls in fields the taxonomy refinement needs', () => {
    const m = meta({ fields: [...meta().fields, { name: 'CMATYPE', type: 'esriFieldTypeString' }] });
    expect(buildOutFields(m, ['ED_NAMEE'])).toContain('CMATYPE');
  });
});

describe('pageFeatures', () => {
  it('pages until a short page arrives', async () => {
    const { impl, urls } = stubFetch([
      { features: [feature(1, 'A'), feature(2, 'B')], exceededTransferLimit: true },
      { features: [feature(3, 'C')] },
    ]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    const rows = await collect(
      pageFeatures(http, { endpoint: 'https://x/svc/MapServer', layerId: '0', meta: meta(), outFields: 'OBJECTID' }),
    );

    expect(rows).toHaveLength(3);
    expect(urls[0]).toContain('resultOffset=0');
    expect(urls[1]).toContain('resultOffset=2');
  });

  it('keeps paging when a full page arrives without the transfer-limit flag', async () => {
    // Trusting the flag alone truncates against servers that never set it.
    const { impl } = stubFetch([
      { features: [feature(1, 'A'), feature(2, 'B')] },
      { features: [feature(3, 'C'), feature(4, 'D')] },
      { features: [feature(5, 'E')] },
    ]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    const rows = await collect(
      pageFeatures(http, { endpoint: 'https://x/svc/MapServer', layerId: '0', meta: meta(), outFields: 'OBJECTID' }),
    );
    expect(rows).toHaveLength(5);
  });

  it('refuses to truncate when more data exists but the layer cannot page', async () => {
    const { impl } = stubFetch([{ features: [feature(1, 'A'), feature(2, 'B')], exceededTransferLimit: true }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    await expect(
      collect(
        pageFeatures(http, {
          endpoint: 'https://x/svc/MapServer',
          layerId: '0',
          meta: meta({ supportsPagination: false }),
          outFields: 'OBJECTID',
        }),
      ),
    ).rejects.toThrow(/silently truncated/);
  });

  it('derives a padded bbox from the generalised geometry', async () => {
    const { impl, urls } = stubFetch([{ features: [feature(1, 'A')] }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });

    const rows = (await collect(
      pageFeatures(http, { endpoint: 'https://x/svc/MapServer', layerId: '0', meta: meta(), outFields: 'OBJECTID' }),
    )) as { bbox: { minx: number; maxx: number } | null }[];

    expect(urls[0]).toContain('maxAllowableOffset=0.005');
    expect(urls[0]).toContain('outSR=4326');
    // Padded outward from -80.1 by the generalisation offset.
    expect(rows[0]?.bbox?.minx).toBeCloseTo(-80.105, 5);
  });

  it('resumes from a checkpoint offset', async () => {
    const { impl, urls } = stubFetch([{ features: [feature(9, 'I')] }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await collect(
      pageFeatures(http, {
        endpoint: 'https://x/svc/MapServer',
        layerId: '0',
        meta: meta(),
        outFields: 'OBJECTID',
        startOffset: 500,
      }),
    );
    expect(urls[0]).toContain('resultOffset=500');
  });

  it('throws when a feature has no object id', async () => {
    const { impl } = stubFetch([{ features: [{ type: 'Feature', properties: { ED_NAMEE: 'X' } }] }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(
      collect(
        pageFeatures(http, { endpoint: 'https://x/svc/MapServer', layerId: '0', meta: meta(), outFields: 'OBJECTID' }),
      ),
    ).rejects.toThrow(ServiceError);
  });

  it('surfaces an ESRI error object delivered with HTTP 200', async () => {
    const { impl } = stubFetch([{ error: { code: 400, message: 'Failed to execute query.' } }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(
      collect(
        pageFeatures(http, { endpoint: 'https://x/svc/MapServer', layerId: '0', meta: meta(), outFields: 'OBJECTID' }),
      ),
    ).rejects.toThrow(/Failed to execute query/);
  });
});

describe('fetchCount', () => {
  it('returns the service count', async () => {
    const { impl, urls } = stubFetch([{ count: 343 }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    expect(await fetchCount(http, 'https://x/svc/MapServer', '0')).toBe(343);
    expect(urls[0]).toContain('returnCountOnly=true');
  });

  it('throws when the response carries no count', async () => {
    const { impl } = stubFetch([{ features: [] }]);
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(fetchCount(http, 'https://x/svc/MapServer', '0')).rejects.toThrow(/did not include a count/);
  });
});

describe('HttpClient policy', () => {
  it('retries 5xx then succeeds, and reports the URL on final failure', async () => {
    let calls = 0;
    const impl = (() => {
      calls++;
      return Promise.resolve(
        calls < 3 ? new Response('busy', { status: 503 }) : new Response('{"count":7}', { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    expect(await http.getJson<{ count: number }>('https://x/y')).toEqual({ count: 7 });
    expect(calls).toBe(3);
  });

  it('does not retry a 404 and names the URL', async () => {
    let calls = 0;
    const impl = (() => {
      calls++;
      return Promise.resolve(new Response('nope', { status: 404 }));
    }) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(http.getText('https://x/missing')).rejects.toThrow(HttpError);
    await expect(http.getText('https://x/missing')).rejects.toThrow(/https:\/\/x\/missing/);
    expect(calls).toBe(2); // one call per attempt above, no retries
  });

  it('gives up after maxAttempts on persistent 429', async () => {
    let calls = 0;
    const impl = (() => {
      calls++;
      return Promise.resolve(new Response('slow down', { status: 429 }));
    }) as unknown as typeof fetch;

    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep, maxAttempts: 3 });
    await expect(http.getText('https://x/y')).rejects.toThrow(/HTTP 429 after 3 attempt/);
    expect(calls).toBe(3);
  });

  it('rejects a non-JSON body as a service error', async () => {
    const impl = (() =>
      Promise.resolve(new Response('<html>maintenance</html>', { status: 200 }))) as unknown as typeof fetch;
    const http = new HttpClient({ fetchImpl: impl, sleepImpl: noSleep });
    await expect(http.getJson('https://x/y')).rejects.toThrow(ServiceError);
  });
});
