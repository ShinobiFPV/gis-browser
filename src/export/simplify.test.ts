import { describe, expect, it } from 'vitest';
import { clampRetention, simplify } from './simplify';
import { countVertices, type Geometry } from '../harvester/normalize/crs';
import { countParts, countRings, type Ring } from './winding';

/**
 * The topology guarantee is the reason this module exists, so it is tested directly
 * rather than assumed from mapshaper's documentation.
 */

/** A wiggly north-south line with many vertices, shared by two adjacent polygons. */
function sharedEdge(n = 200): Ring {
  const pts: Ring = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([-80 + 0.02 * Math.sin(t * 40), 45 + t]);
  }
  return pts;
}

function adjacentPair(): { left: Geometry; right: Geometry } {
  const edge = sharedEdge();
  return {
    left: { type: 'Polygon', coordinates: [[[-81, 45], ...edge, [-81, 46], [-81, 45]]] },
    right: { type: 'Polygon', coordinates: [[...[...edge].reverse(), [-79, 46], [-79, 45], edge[0]!]] },
  };
}

function circle(cx: number, cy: number, r: number, n: number, dir = 1): Ring {
  const pts: Ring = [];
  for (let i = 0; i <= n; i++) {
    const t = ((dir * i) / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

/** Points on the shared edge, as comparable strings. */
function edgePoints(geometry: Geometry): Set<string> {
  const ring = (geometry.coordinates as Ring[])[0]!;
  return new Set(
    ring
      .filter((p) => (p[0] as number) > -80.5 && (p[0] as number) < -79.5)
      .map((p) => `${(p[0] as number).toFixed(9)},${(p[1] as number).toFixed(9)}`),
  );
}

describe('clampRetention', () => {
  it('keeps mapshaper inside the percentages it accepts', () => {
    expect(clampRetention(0)).toBe(1);
    expect(clampRetention(-5)).toBe(1);
    expect(clampRetention(150)).toBe(100);
    expect(clampRetention(5.4)).toBe(5);
    expect(clampRetention(Number.NaN)).toBe(100);
  });
});

describe('simplify', () => {
  it('reduces vertex count', async () => {
    const { left } = adjacentPair();
    const before = countVertices(left);
    const result = await simplify([{ key: 'left', geometry: left }], 5);
    expect(result.verticesBefore).toBe(before);
    expect(result.verticesAfter).toBeLessThan(before);
    expect(result.skipped).toBe(false);
  });

  it('keeps a shared border shared, so no gap opens between neighbours', async () => {
    const { left, right } = adjacentPair();

    const together = await simplify(
      [
        { key: 'left', geometry: left },
        { key: 'right', geometry: right },
      ],
      5,
    );

    const a = edgePoints(together.features[0]!.geometry);
    const b = edgePoints(together.features[1]!.geometry);
    expect(a.size).toBeGreaterThan(0);
    const divergent = [...a].filter((p) => !b.has(p)).length + [...b].filter((p) => !a.has(p)).length;
    expect(divergent).toBe(0);
  });

  it('demonstrates the gap that appears when features are simplified separately', async () => {
    // This is the failure the brief warns about. Asserting it here means the guarantee
    // above is a real property of exporting together, not an accident of the test data.
    const { left, right } = adjacentPair();
    const a = await simplify([{ key: 'left', geometry: left }], 5);
    const b = await simplify([{ key: 'right', geometry: right }], 5);

    const pa = edgePoints(a.features[0]!.geometry);
    const pb = edgePoints(b.features[0]!.geometry);
    const divergent = [...pa].filter((p) => !pb.has(p)).length + [...pb].filter((p) => !pa.has(p)).length;
    expect(divergent).toBeGreaterThan(0);
  });

  it('passes geometry through untouched at 100% retention', async () => {
    const { left } = adjacentPair();
    const result = await simplify([{ key: 'left', geometry: left }], 100);
    expect(result.skipped).toBe(true);
    expect(result.verticesAfter).toBe(result.verticesBefore);
    expect(result.features[0]!.geometry).toBe(left);
  });

  it('keeps a small polygon that Visvalingam alone would delete', async () => {
    // Without keep-shapes, the tiny one vanishes entirely at 1%. Losing a reserve because
    // it is small is the exact failure this app exists to prevent.
    const big: Geometry = { type: 'Polygon', coordinates: [circle(-80, 45, 2, 400)] };
    const tiny: Geometry = { type: 'Polygon', coordinates: [circle(-70, 45, 0.0005, 400)] };

    const result = await simplify(
      [
        { key: 'big', geometry: big },
        { key: 'tiny', geometry: tiny },
      ],
      1,
    );

    expect(result.features).toHaveLength(2);
    expect(result.features.map((f) => f.key)).toEqual(['big', 'tiny']);
    for (const f of result.features) expect(countVertices(f.geometry)).toBeGreaterThan(0);
  });

  it('preserves input order and keys so results map back to provenance', async () => {
    const inputs = Array.from({ length: 6 }, (_, i) => ({
      key: `f${i}`,
      geometry: { type: 'Polygon', coordinates: [circle(-80 + i * 3, 45, 1, 150)] },
    }));
    const result = await simplify(inputs, 20);
    expect(result.features.map((f) => f.key)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  });

  it('keeps a hole with enough vertices to survive', async () => {
    const donut: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[circle(-80, 45, 1, 300, 1), circle(-80, 45, 0.4, 300, -1)]],
    };
    const result = await simplify([{ key: 'donut', geometry: donut }], 5);
    // Ring count is the property that matters. Structure is checked via countRings rather
    // than by indexing, because mapshaper collapses a single-part MultiPolygon to a
    // Polygon on the way out — see the next test.
    expect(countRings(result.features[0]!.geometry)).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('collapses a single-part MultiPolygon to a Polygon, without losing a ring', async () => {
    // Documented because it surprised me: the output geometry type is not always the input
    // geometry type. Both are valid GeoJSON areas and downstream code handles either, but
    // anything that indexes into coordinates must not assume the input shape survived.
    const donut: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[circle(-80, 45, 1, 300, 1), circle(-80, 45, 0.4, 300, -1)]],
    };
    const result = await simplify([{ key: 'donut', geometry: donut }], 5);
    expect(result.features[0]!.geometry.type).toBe('Polygon');
    expect(countRings(result.features[0]!.geometry)).toBe(countRings(donut));
  });

  it('keeps a genuinely multi-part boundary as a MultiPolygon', async () => {
    const twoParts: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[circle(-80, 45, 1, 200)], [circle(-70, 45, 1, 200)]],
    };
    const result = await simplify([{ key: 'islands', geometry: twoParts }], 5);
    expect(result.features[0]!.geometry.type).toBe('MultiPolygon');
    expect(countParts(result.features[0]!.geometry)).toBe(2);
  });

  it('warns rather than staying silent when a hole is simplified away', async () => {
    // A coarse 4-corner hole on an equally coarse exterior does get dropped. Real
    // boundaries rarely hit this, but a lost enclave must never be silent.
    const coarse: Geometry = {
      type: 'Polygon',
      coordinates: [
        [[-80, 45], [-79, 45], [-79, 46], [-80, 46], [-80, 45]],
        [[-79.8, 45.2], [-79.8, 45.8], [-79.2, 45.8], [-79.2, 45.2], [-79.8, 45.2]],
      ],
    };
    const result = await simplify([{ key: 'coarse', geometry: coarse }], 50);
    if (countRings(result.features[0]!.geometry) < countRings(coarse)) {
      expect(result.warnings.join(' ')).toMatch(/enclaves? or holes?/);
      expect(result.warnings.join(' ')).toMatch(/Raise the slider/);
    }
  });

  it('keeps the hole count and the listed areas describing the same shapes', async () => {
    // The bug this guards: counting exteriors and holes together reported "lost 99
    // enclaves" while listing 21,287 areas, because dropped islands took their lakes along.
    const withHoles: Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [circle(-72, 52, 2, 400), circle(-72, 52, 0.001, 40, -1), circle(-71.5, 52, 0.001, 40, -1)],
        ...Array.from({ length: 30 }, (_, i) => [circle(-70 + i * 0.2, 50, 0.0008, 40)]),
      ],
    };
    const result = await simplify([{ key: 'lakes#0', geometry: withHoles }], 1);
    const holeWarning = result.warnings.find((w) => w.includes('enclave'));
    if (holeWarning) {
      const [, lost, total] = /lost (\d+) of (\d+) enclaves? or holes?/.exec(holeWarning) ?? [];
      expect(Number(total)).toBe(2);
      expect(Number(lost)).toBeLessThanOrEqual(2);
      const listed = /\((\d+) in total/.exec(holeWarning);
      if (listed) expect(Number(listed[1])).toBe(Number(lost));
    }
  });

  it('says how big a dropped part was, so the artist can judge whether to care', async () => {
    // The real case this exists for: a reserve whose third part is a 0.3 ha rock. Warning
    // that "a part was lost" without a size sends someone hunting for a problem that a
    // broadcast canvas could not render anyway.
    const mainland = circle(-80, 45, 0.5, 400);
    const islet = circle(-79, 45, 0.0006, 400);
    const geometry: Geometry = { type: 'MultiPolygon', coordinates: [[mainland], [islet]] };

    const result = await simplify([{ key: 'reserve#0', geometry }], 2);
    if (countParts(result.features[0]!.geometry) < 2) {
      const text = result.warnings.join(' ');
      expect(text).toMatch(/Dropped:/);
      expect(text).toMatch(/m²|ha|km²/);
      // The key is stripped of its disambiguating index before it reaches a human.
      expect(text).toContain('"reserve"');
      expect(text).not.toContain('reserve#0');
    }
  });
});

describe('warning volume', () => {
  it('summarises rather than listing thousands of dropped islands', async () => {
    // Quebec is 21,492 separate polygons. Naming each dropped one produced half a megabyte
    // of warning text, which is the same as saying nothing.
    const parts = [
      [circle(-72, 52, 2, 300)],
      ...Array.from({ length: 60 }, (_, i) => [circle(-70 + (i % 10) * 0.3, 50 + Math.floor(i / 10) * 0.3, 0.0008, 40)]),
    ];
    const geometry: Geometry = { type: 'MultiPolygon', coordinates: parts };

    const result = await simplify([{ key: 'quebec#0', geometry }], 1);
    const text = result.warnings.join(' ');
    if (text) {
      expect(text.length).toBeLessThan(500);
      expect(text).toMatch(/Largest dropped:|Dropped:/);
      // At most three sizes are named, however many were lost.
      expect((text.match(/\d+(\.\d+)? (m²|ha|km²)/g) ?? []).length).toBeLessThanOrEqual(5);
    }
  });
});

describe('area helpers', () => {
  it('formats small, medium and large areas in units an artist reads at a glance', async () => {
    const { formatArea } = await import('./winding');
    expect(formatArea(0.3)).toBe('3000 m²');
    expect(formatArea(12.34)).toBe('12.3 ha');
    expect(formatArea(5000)).toBe('50.0 km²');
  });

  it('treats the smallest shapes as the dropped ones', async () => {
    const { droppedAreas } = await import('./winding');
    expect(droppedAreas([100, 50, 0.3], [100, 50])).toEqual([0.3]);
    expect(droppedAreas([100, 50], [100, 50])).toEqual([]);
  });

  it('returns an empty result for an empty selection rather than throwing', async () => {
    const result = await simplify([], 5);
    expect(result.features).toEqual([]);
    expect(result.skipped).toBe(true);
  });
});
