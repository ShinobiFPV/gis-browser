import { describe, expect, it } from 'vitest';
import { SEED_SOURCES, DISCOVERY_CATALOGS } from './sources';
import { isFeatureType, isJurisdiction } from '@shared/taxonomy';

/**
 * These are offline invariants only -- they never hit the network. The point is to catch
 * a malformed registry entry at commit time; live endpoint verification is a separate,
 * deliberate step.
 */
describe('seed source registry', () => {
  it('is not empty', () => {
    expect(SEED_SOURCES.length).toBeGreaterThan(0);
  });

  it('uses only taxonomy feature types', () => {
    for (const s of SEED_SOURCES) {
      expect(isFeatureType(s.featureType), `${s.name} -> ${s.featureType}`).toBe(true);
    }
  });

  it('uses only known jurisdiction codes', () => {
    for (const s of SEED_SOURCES) {
      if (s.jurisdiction === null) continue;
      expect(isJurisdiction(s.jurisdiction), `${s.name} -> ${s.jurisdiction}`).toBe(true);
    }
  });

  it('has an https endpoint for every source', () => {
    for (const s of SEED_SOURCES) {
      expect(s.endpoint.startsWith('https://'), `${s.name} -> ${s.endpoint}`).toBe(true);
    }
  });

  it('carries a licence and an on-air attribution string for every source', () => {
    for (const s of SEED_SOURCES) {
      expect(s.licence.length, `${s.name} licence`).toBeGreaterThan(0);
      expect(s.attribution.length, `${s.name} attribution`).toBeGreaterThan(0);
    }
  });

  it('declares at least one name field for every source', () => {
    for (const s of SEED_SOURCES) {
      expect(s.nameFields.length, `${s.name} nameFields`).toBeGreaterThan(0);
    }
  });

  it('records a verification date for every source', () => {
    for (const s of SEED_SOURCES) {
      expect(s.verifiedAt, `${s.name} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gives Tier A sources a layer id and Tier B sources a file URL', () => {
    for (const s of SEED_SOURCES) {
      if (s.tier === 'A') expect(s.layerId, `${s.name} layerId`).not.toBeNull();
      else expect(s.kind, `${s.name} kind`).toBe('bulk-file');
    }
  });

  it('has no duplicate (endpoint, layerId, featureType) triples', () => {
    const seen = new Set<string>();
    for (const s of SEED_SOURCES) {
      const key = `${s.endpoint}|${s.layerId}|${s.featureType}`;
      expect(seen.has(key), `duplicate registry entry: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('covers the federal electoral districts back through several representation orders', () => {
    const feds = SEED_SOURCES.filter((s) => s.featureType === 'federal_electoral_district');
    expect(feds.length).toBeGreaterThanOrEqual(5);
    // The 2023 order is the current one and must be present with the right seat count.
    const current = feds.find((s) => s.vintage === '2023 representation order');
    expect(current).toBeDefined();
    expect(current?.verifiedCount).toBe(343);
  });

  it('lists discovery catalogs for the M7 crawlers', () => {
    expect(DISCOVERY_CATALOGS.length).toBeGreaterThan(0);
    for (const c of DISCOVERY_CATALOGS) expect(c.endpoint.startsWith('https://')).toBe(true);
  });
});
