import { describe, expect, it } from 'vitest';
import { buildSvg, toSvgId, type SvgOptions } from './svg';
import type { Geometry } from '../harvester/normalize/crs';
import type { Ring } from './winding';

const OPTIONS: SvgOptions = {
  width: 1920,
  height: 1080,
  padding: 40,
  srid: 3347,
  precision: 2,
  title: 'Test',
  attribution: 'Natural Resources Canada',
  generatedBy: 'GIS Browser 0.1.0',
  generatedAt: '2026-08-16T12:00:00.000Z',
};

const SQUARE: Ring = [
  [-80.2, 45.2],
  [-80.0, 45.2],
  [-80.0, 45.4],
  [-80.2, 45.4],
  [-80.2, 45.2],
];

const POLY: Geometry = { type: 'Polygon', coordinates: [SQUARE] };

/** Pulls every "x,y" pair out of a path's d attribute. */
function pointsIn(svg: string): [number, number][] {
  const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
  return [...d.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[2]), Number(m[3])]);
}

describe('toSvgId', () => {
  it('produces a valid, lowercase, hyphenated id', () => {
    expect(toSvgId('PARRY ISLAND FIRST NATION', new Set())).toBe('parry-island-first-nation');
  });

  it('strips diacritics so accented names stay readable', () => {
    expect(toSvgId('Rivière-du-Loup', new Set())).toBe('riviere-du-loup');
  });

  it('never starts an id with a digit, which XML forbids', () => {
    expect(toSvgId('45 Sarnia', new Set())).toMatch(/^n?4?5?-?sarnia|^n45-sarnia$/);
    expect(toSvgId('45 Sarnia', new Set())[0]).not.toMatch(/\d/);
  });

  it('deduplicates, because the same reserve name appears in more than one source', () => {
    const taken = new Set<string>();
    expect(toSvgId('Sarnia 45', taken)).toBe('sarnia-45');
    expect(toSvgId('Sarnia 45', taken)).toBe('sarnia-45-2');
    expect(toSvgId('Sarnia 45', taken)).toBe('sarnia-45-3');
  });

  it('falls back rather than producing an empty id', () => {
    expect(toSvgId('!!!', new Set())).toBe('feature');
  });
});

describe('buildSvg', () => {
  it('produces a well-formed svg with the requested canvas', () => {
    const { text } = buildSvg([{ name: 'A', geometry: POLY }], OPTIONS);
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('width="1920" height="1080"');
    expect(text).toContain('viewBox="0 0 1920 1080"');
    expect(text.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('fits inside the canvas, honouring the padding', () => {
    const { text } = buildSvg([{ name: 'A', geometry: POLY }], OPTIONS);
    for (const [x, y] of pointsIn(text)) {
      expect(x).toBeGreaterThanOrEqual(OPTIONS.padding - 0.01);
      expect(x).toBeLessThanOrEqual(OPTIONS.width - OPTIONS.padding + 0.01);
      expect(y).toBeGreaterThanOrEqual(OPTIONS.padding - 0.01);
      expect(y).toBeLessThanOrEqual(OPTIONS.height - OPTIONS.padding + 0.01);
    }
  });

  it('flips the Y axis, because SVG counts downward and northings count upward', () => {
    // A tall thin polygon: its northernmost point must land at the SMALLEST svg y.
    const tall: Geometry = {
      type: 'Polygon',
      coordinates: [[[-80, 45], [-79.99, 45], [-79.99, 50], [-80, 50], [-80, 45]]],
    };
    const { text } = buildSvg([{ name: 'tall', geometry: tall }], OPTIONS);
    const ys = pointsIn(text).map(([, y]) => y);
    // The first coordinate is the southern corner, so it must be the larger y.
    expect(Math.max(...ys)).toBeGreaterThan(Math.min(...ys));
    expect(pointsIn(text)[0]![1]).toBe(Math.max(...ys));
  });

  it('projects rather than drawing raw lon/lat', () => {
    // At 45N a Plate Carree square would come out square. Under Lambert it must not.
    const square: Geometry = {
      type: 'Polygon',
      coordinates: [[[-80, 45], [-79, 45], [-79, 46], [-80, 46], [-80, 45]]],
    };
    const projected = buildSvg([{ name: 's', geometry: square }], OPTIONS);
    const raw = buildSvg([{ name: 's', geometry: square }], { ...OPTIONS, srid: 4326 });
    expect(projected.text).not.toBe(raw.text);
    expect(projected.unitsPerPixel).toBeGreaterThan(0);
  });

  it('emits one group per feature, id-named for Illustrator layers', () => {
    const { text } = buildSvg(
      [
        { name: 'Parry Island First Nation', geometry: POLY },
        { name: 'Shawanaga 17', geometry: POLY },
      ],
      OPTIONS,
    );
    expect(text).toContain('<g id="parry-island-first-nation"');
    expect(text).toContain('<g id="shawanaga-17"');
    expect(text.match(/<path /g)).toHaveLength(2);
  });

  it('puts every ring of one feature in a single path, so holes work with evenodd', () => {
    const donut: Geometry = {
      type: 'Polygon',
      coordinates: [
        SQUARE,
        [
          [-80.15, 45.25],
          [-80.15, 45.35],
          [-80.05, 45.35],
          [-80.05, 45.25],
          [-80.15, 45.25],
        ],
      ],
    };
    const { text } = buildSvg([{ name: 'donut', geometry: donut }], OPTIONS);
    expect(text.match(/<path /g)).toHaveLength(1);
    const d = /<path d="([^"]+)"/.exec(text)?.[1] ?? '';
    expect(d.match(/M/g)).toHaveLength(2);
    expect(text).toContain('fill-rule="evenodd"');
  });

  it('closes area subpaths with Z', () => {
    const { text } = buildSvg([{ name: 'A', geometry: POLY }], OPTIONS);
    expect(/<path d="[^"]*Z"/.test(text)).toBe(true);
  });

  it('escapes XML in names and attribution', () => {
    const { text } = buildSvg([{ name: 'A & B <script>', geometry: POLY }], {
      ...OPTIONS,
      attribution: 'Credit & more',
    });
    expect(text).toContain('&amp;');
    expect(text).not.toContain('<script>');
  });

  it('records projection, scale and credit in desc, so the file explains itself', () => {
    const { text } = buildSvg([{ name: 'A', geometry: POLY }], OPTIONS);
    const desc = /<desc>([^<]*)<\/desc>/.exec(text)?.[1] ?? '';
    expect(desc).toContain('Natural Resources Canada');
    expect(desc).toContain('EPSG:3347');
    expect(desc).toContain('units per pixel');
  });

  it('handles a MultiPolygon by drawing every part', () => {
    const multi: Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [SQUARE],
        [[[-79.5, 45.2], [-79.3, 45.2], [-79.3, 45.4], [-79.5, 45.2]]],
      ],
    };
    const { text } = buildSvg([{ name: 'multi', geometry: multi }], OPTIONS);
    const d = /<path d="([^"]+)"/.exec(text)?.[1] ?? '';
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('scales two features to a common extent rather than fitting each separately', () => {
    const near: Geometry = POLY;
    const far: Geometry = {
      type: 'Polygon',
      coordinates: [[[-70, 50], [-69, 50], [-69, 51], [-70, 51], [-70, 50]]],
    };
    const both = buildSvg(
      [
        { name: 'near', geometry: near },
        { name: 'far', geometry: far },
      ],
      OPTIONS,
    );
    const alone = buildSvg([{ name: 'near', geometry: near }], OPTIONS);
    expect(both.unitsPerPixel).toBeGreaterThan(alone.unitsPerPixel);
  });

  it('refuses a canvas that padding leaves no room on', () => {
    expect(() => buildSvg([{ name: 'A', geometry: POLY }], { ...OPTIONS, padding: 1000 })).toThrow(
      /leaves no room/,
    );
  });

  it('refuses an empty selection loudly', () => {
    expect(() => buildSvg([], OPTIONS)).toThrow(/Nothing to draw/);
  });

  it('rejects an unknown projection rather than silently drawing lon/lat', () => {
    expect(() => buildSvg([{ name: 'A', geometry: POLY }], { ...OPTIONS, srid: 9999 })).toThrow(
      /not one of the offered/,
    );
  });
});
