import { describe, expect, it } from 'vitest';
import { selectStarterSources, shouldShowWizard, STARTER_TYPES } from './first-run';
import type { SourceRow } from '@shared/types';

function source(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    name: 'A source',
    kind: 'esri-rest',
    tier: 'A',
    endpoint: 'https://example.ca/FeatureServer',
    layer_id: '0',
    feature_type: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: null,
    licence: null,
    attribution: null,
    name_fields: null,
    last_harvested_at: null,
    feature_count: null,
    status: 'seeded',
    source_srid: null,
    verified_count: null,
    verified_at: null,
    notes: null,
    identity_field: null,
    archive_bytes: null,
  region: 'canada',
    ...over,
  };
}

describe('shouldShowWizard', () => {
  it('shows on a fresh install', () => {
    expect(shouldShowWizard({ featureCount: 0, completedAt: null })).toBe(true);
  });

  it('never shows once anything is indexed', () => {
    expect(shouldShowWizard({ featureCount: 1, completedAt: null })).toBe(false);
    expect(shouldShowWizard({ featureCount: 90_000, completedAt: '2026-08-16T00:00:00Z' })).toBe(false);
  });

  it('does not nag someone who deliberately skipped', () => {
    expect(shouldShowWizard({ featureCount: 0, completedAt: '2026-08-16T00:00:00Z' })).toBe(false);
  });

  it('returns for an install whose catalog was emptied and never answered', () => {
    // A first harvest that failed outright, or a database deleted to reclaim disk, puts
    // someone back in exactly the state the wizard exists for.
    expect(shouldShowWizard({ featureCount: 0, completedAt: null })).toBe(true);
  });
});

describe('selectStarterSources', () => {
  const registry: SourceRow[] = [
    source({ id: 1, feature_type: 'federal_electoral_district' }),
    source({ id: 2, feature_type: 'census_tract' }),
    source({ id: 3, feature_type: 'province_territory' }),
    source({ id: 4, feature_type: 'dissemination_area', tier: 'B', kind: 'bulk-file', archive_bytes: 197_042_003 }),
    source({ id: 5, feature_type: 'indian_reserve' }),
    source({ id: 6, feature_type: 'forward_sortation_area' }),
  ];

  it('essential keeps only the types a newsroom asks for first', () => {
    const { sourceIds } = selectStarterSources(registry, 'essential');
    expect(sourceIds).toContain(1);
    expect(sourceIds).toContain(3);
    expect(sourceIds).toContain(5);
    expect(sourceIds).not.toContain(2); // census tracts
    expect(sourceIds).not.toContain(6); // postal areas
  });

  it('orders by what matters, so a cancelled run leaves the useful half indexed', () => {
    const { sourceIds } = selectStarterSources(registry, 'essential');
    const types = sourceIds.map((id) => registry.find((s) => s.id === id)!.feature_type);
    const ranks = types.map((t) => STARTER_TYPES.indexOf(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Federal ridings lead: election night is the case the app is shaped around.
    expect(types[0]).toBe('federal_electoral_district');
  });

  it('never includes a Tier B download in any plan', () => {
    // The brief makes bulk sources explicitly user-triggered. A wizard quietly pulling
    // 197 MB on first launch would be the exact opposite of that.
    for (const plan of ['essential', 'tier-a'] as const) {
      const { sourceIds, excluded, downloadBytes } = selectStarterSources(registry, plan);
      expect(sourceIds).not.toContain(4);
      expect(downloadBytes).toBe(0);
      expect(excluded.find((e) => e.reason.includes('bulk download'))).toBeDefined();
    }
  });

  it('tier-a takes everything queryable but still not the bulk files', () => {
    const { sourceIds } = selectStarterSources(registry, 'tier-a');
    expect(sourceIds).toEqual(expect.arrayContaining([1, 2, 3, 5, 6]));
    expect(sourceIds).not.toContain(4);
  });

  it('skip harvests nothing', () => {
    expect(selectStarterSources(registry, 'skip')).toEqual({ sourceIds: [], excluded: [], downloadBytes: 0 });
  });

  it('leaves out what is already harvested, so a retry resumes', () => {
    const partly = [source({ id: 1, status: 'ok' }), source({ id: 2, status: 'seeded' })];
    const { sourceIds, excluded } = selectStarterSources(partly, 'essential');
    expect(sourceIds).toEqual([2]);
    expect(excluded.find((e) => e.reason === 'already harvested')).toBeDefined();
  });

  it('leaves out disabled sources and discovery catalogs', () => {
    const odd = [
      source({ id: 1, status: 'disabled' }),
      source({ id: 2, kind: 'ckan', endpoint: 'https://example.ca/api/3' }),
      source({ id: 3, kind: 'arcgis-hub', endpoint: 'https://hub.arcgis.com/api/v3' }),
    ];
    expect(selectStarterSources(odd, 'tier-a').sourceIds).toEqual([]);
  });

  it('is honest about what it left out', () => {
    const { excluded } = selectStarterSources(registry, 'essential');
    // Every source not selected is accounted for with a reason, rather than silently gone.
    expect(excluded).toHaveLength(registry.length - selectStarterSources(registry, 'essential').sourceIds.length);
    for (const e of excluded) expect(e.reason).toBeTruthy();
  });

  it('covers a source of every starter type', () => {
    // Guards against a taxonomy rename quietly emptying the essential plan.
    const all = STARTER_TYPES.map((t, i) => source({ id: i + 1, feature_type: t }));
    expect(selectStarterSources(all, 'essential').sourceIds).toHaveLength(STARTER_TYPES.length);
  });
});
