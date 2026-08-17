import { FuzzyIndex, type FuzzyEntry } from '@resolve/fuzzy';
import { normalizeText } from '../../harvester/normalize/aliases';
import type { Geometry } from '../../harvester/normalize/crs';
import type { FeatureType } from '@shared/taxonomy';

/**
 * The mobile catalog: one static file, held in memory.
 *
 * The desktop app harvests into SQLite. A phone cannot -- there is no native module in a
 * browser, and no reason to put a 2 GB catalog on a handset even if there were. So the
 * index is built once on a desktop (scripts/build-mobile-index.mjs) and shipped as a
 * single gzipped file: names, aliases, type, jurisdiction, source and bounding box, and
 * no geometry at all.
 *
 * That is the same architectural decision the desktop app makes, arrived at from the
 * opposite direction. Geometry is fetched when you export something.
 */

/**
 * Field order matches the generator. Positional to keep the file small.
 *
 * Exported for the tests, which build a packed index by hand -- the tuple order here and
 * the one in scripts/build-mobile-index.mjs are two halves of a wire format with nothing
 * but a comment holding them together, and a silent reordering would produce a catalog full
 * of features whose type and jurisdiction had swapped places.
 */
export type PackedFeature = [
  id: number,
  name: string,
  typeIdx: number,
  jurIdx: number,
  sourceIdx: number,
  sourceFeatureId: string,
  minx: number | null,
  miny: number | null,
  maxx: number | null,
  maxy: number | null,
  aliases: string[],
];

export type PackedSource = [
  id: number,
  name: string,
  kind: string,
  endpoint: string,
  layerId: string,
  licence: string,
  attribution: string,
  vintage: string | null,
  srid: number | null,
  identityField: string | null,
  verifiedAt: string | null,
];

export interface PackedIndex {
  format: number;
  built: string;
  types: string[];
  jurisdictions: (string | null)[];
  sources: PackedSource[];
  jurisdictionLabels: Record<string, string>;
  features: PackedFeature[];
}

export interface MobileSource {
  id: number;
  name: string;
  kind: string;
  endpoint: string;
  layerId: string;
  licence: string;
  attribution: string;
  vintage: string | null;
  srid: number | null;
  /**
   * The attribute identifying a real-world feature on a multipart layer. When set, geometry
   * is fetched with a where-clause on it rather than by object id -- see lib/geometry.ts.
   */
  identityField: string | null;
  verifiedAt: string | null;
}

export interface MobileFeature {
  id: number;
  name: string;
  featureType: FeatureType;
  jurisdiction: string | null;
  source: MobileSource;
  sourceFeatureId: string;
  bbox: [number, number, number, number] | null;
}

export interface Catalog {
  built: string;
  features: Map<number, MobileFeature>;
  fuzzy: FuzzyIndex;
  /** Normalised alias -> feature ids, for the exact and prefix passes. */
  byAlias: Map<string, number[]>;
  jurisdictionLabels: Map<string, string>;
  /** Every jurisdiction with something behind it, for the filter. */
  jurisdictions: { code: string; label: string; count: number }[];
  types: Set<FeatureType>;
}

/** The format this build understands. A mismatch means the cached file is from elsewhere. */
const EXPECTED_FORMAT = 1;

/**
 * Loads the index, decompressing it ourselves only if the host has not already.
 *
 * The index is shipped pre-compressed rather than relying on the host to negotiate
 * Content-Encoding, because GitHub Pages will happily serve a .json uncompressed and 3 MB
 * over mobile data is not the same thing as 850 KB.
 *
 * What that runs into is that STATIC HOSTS DISAGREE ABOUT `.gz`. GitHub Pages serves it as
 * an opaque file, so the bytes arrive still compressed and this code has to inflate them.
 * nginx with gzip_static, most CDNs, and the Vite preview server instead recognise the
 * extension and set `Content-Encoding: gzip`, so the browser inflates it in transit and the
 * bytes arrive as plain JSON. Both are reasonable; neither is detectable from the response,
 * because fetch deliberately hides Content-Encoding on a decoded response.
 *
 * So the payload is asked what it is. Two bytes -- 1f 8b, the gzip magic number -- decide,
 * and the app works on either kind of host without a per-deploy setting that somebody would
 * have to get right.
 */
async function loadGzipJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const stillCompressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (!stillCompressed) return JSON.parse(new TextDecoder().decode(bytes)) as T;

  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser cannot decompress the catalog (no DecompressionStream). ' +
        'Chrome 80+, Safari 16.4+ or Firefox 113+ is required.',
    );
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text) as T;
}

export function unpack(packed: PackedIndex): Catalog {
  if (packed.format !== EXPECTED_FORMAT) {
    throw new Error(
      `Catalog format ${packed.format} but this build expects ${EXPECTED_FORMAT}. ` +
        `Clear the app's storage to fetch a fresh one.`,
    );
  }

  const sources = new Map<number, MobileSource>();
  packed.sources.forEach((s, i) => {
    sources.set(i, {
      id: s[0],
      name: s[1],
      kind: s[2],
      endpoint: s[3],
      layerId: s[4],
      licence: s[5],
      attribution: s[6],
      vintage: s[7],
      srid: s[8],
      identityField: s[9],
      verifiedAt: s[10],
    });
  });

  const features = new Map<number, MobileFeature>();
  const byAlias = new Map<string, number[]>();
  const entries: FuzzyEntry[] = [];
  const jurCounts = new Map<string, number>();
  const types = new Set<FeatureType>();

  // aliasId is synthetic here. The desktop's is a database row id; nothing on this side
  // needs it to mean anything beyond "which alias matched".
  let aliasId = 0;

  for (const f of packed.features) {
    const jurisdiction = packed.jurisdictions[f[3]] ?? null;
    const featureType = packed.types[f[2]] as FeatureType;
    const source = sources.get(f[4]);
    if (!source) continue;

    const bbox: [number, number, number, number] | null =
      f[6] !== null && f[7] !== null && f[8] !== null && f[9] !== null ? [f[6], f[7], f[8], f[9]] : null;

    features.set(f[0], {
      id: f[0],
      name: f[1],
      featureType,
      jurisdiction,
      source,
      sourceFeatureId: f[5],
      bbox,
    });

    types.add(featureType);
    if (jurisdiction) jurCounts.set(jurisdiction, (jurCounts.get(jurisdiction) ?? 0) + 1);

    for (const alias of [f[1], ...f[10]]) {
      const text = normalizeText(alias);
      if (!text) continue;
      entries.push({ aliasId: aliasId++, featureId: f[0], text });
      const list = byAlias.get(text);
      if (list) list.push(f[0]);
      else byAlias.set(text, [f[0]]);
    }
  }

  const jurisdictionLabels = new Map(Object.entries(packed.jurisdictionLabels));
  const jurisdictions = [...jurCounts.entries()]
    .map(([code, count]) => ({ code, label: jurisdictionLabels.get(code) ?? code, count }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    built: packed.built,
    features,
    fuzzy: new FuzzyIndex(entries),
    byAlias,
    jurisdictionLabels,
    jurisdictions,
    types,
  };
}

export async function loadCatalog(signal?: AbortSignal): Promise<Catalog> {
  const packed = await loadGzipJson<PackedIndex>('./index.json.gz', signal);
  return unpack(packed);
}

/**
 * Countries, shipped WITH their geometry.
 *
 * Every other boundary is fetched from its source on demand, which is only possible
 * because those services send CORS headers. The countries come from a Natural Earth
 * archive on a host that sends none, so a browser cannot fetch them at all -- verified,
 * not assumed. Their geometry is therefore simplified at build time and bundled.
 *
 * Loaded lazily: most searches never touch a country, and half a megabyte should not be
 * spent before the first keystroke.
 */
let worldPack: Promise<Map<number, Geometry>> | null = null;

export function loadWorldPack(): Promise<Map<number, Geometry>> {
  worldPack ??= loadGzipJson<{ features: { properties: { i: number }; geometry: Geometry }[] }>(
    './world.json.gz',
  ).then((fc) => new Map(fc.features.map((f) => [f.properties.i, f.geometry])));
  return worldPack;
}
