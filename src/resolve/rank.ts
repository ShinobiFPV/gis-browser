import type { FeatureType } from '@shared/taxonomy';
import type { AliasKind } from '@shared/types';

/**
 * Ranking.
 *
 * Duplicate coverage is expected -- the same reserve is in the NRCan layer and in
 * Ontario's, and often in StatCan's census subdivisions too. The brief's rule is to keep
 * them all and let ranking prefer the authoritative one: federal for reserves, StatCan for
 * census geography, provincial for provincial layers.
 */

export type Authority = 'federal' | 'statcan' | 'provincial' | 'elections';

/** Which body is authoritative for each feature type. */
const AUTHORITY_FOR_TYPE: Partial<Record<FeatureType, Authority>> = {
  // Elections Canada draws the federal ridings; StatCan only republishes them.
  federal_electoral_district: 'elections',

  // The Surveyor General defines reserve and settlement boundaries in law.
  indian_reserve: 'federal',
  land_claim_settlement: 'federal',
  inuit_region: 'federal',
  treaty_area: 'federal',
  national_park: 'federal',

  // Census geography is StatCan's by definition.
  province_territory: 'statcan',
  census_division: 'statcan',
  census_subdivision: 'statcan',
  census_metropolitan_area: 'statcan',
  census_agglomeration: 'statcan',
  census_tract: 'statcan',
  dissemination_area: 'statcan',
  population_centre: 'statcan',
  economic_region: 'statcan',
  forward_sortation_area: 'statcan',

  // Everything a province legislates.
  provincial_electoral_district: 'provincial',
  municipality: 'provincial',
  municipal_ward: 'provincial',
  regional_district: 'provincial',
  provincial_park: 'provincial',
  watershed: 'provincial',
  health_region: 'provincial',
  school_board: 'provincial',
};

export interface SourceFacts {
  jurisdiction: string | null;
  attribution: string | null;
  vintage: string | null;
}

/** Classifies a source from its attribution and jurisdiction. */
export function authorityOf(source: SourceFacts): Authority | null {
  const a = (source.attribution ?? '').toLowerCase();
  if (a.includes('elections canada')) return 'elections';
  if (a.includes('statistics canada')) return 'statcan';
  if (a.includes('natural resources canada')) return 'federal';
  if (source.jurisdiction && source.jurisdiction !== 'CA') return 'provincial';
  return null;
}

/** 1 when this source is the authoritative one for the type, 0.5 when it is not. */
export function authorityScore(featureType: FeatureType, source: SourceFacts): number {
  const wanted = AUTHORITY_FOR_TYPE[featureType];
  if (!wanted) return 0.7;
  const actual = authorityOf(source);
  if (actual === null) return 0.5;
  return actual === wanted ? 1 : 0.5;
}

/** Alias provenance: a hit on the official name beats a hit on a derived form. */
export function aliasKindScore(kind: AliasKind | null): number {
  switch (kind) {
    case 'official':
      return 1;
    case 'french':
      return 0.95;
    case 'manual':
      return 0.9;
    case 'attribute':
      return 0.85;
    case 'stripped':
      return 0.8;
    default:
      return 0.7;
  }
}

export interface ScoreInput {
  featureType: FeatureType;
  jurisdiction: string | null;
  source: SourceFacts;
  aliasKind: AliasKind | null;
  /** 0..1 from the name matcher (exact, FTS or fuzzy). */
  nameScore: number;
  /** True when the alias matched the query exactly after normalisation. */
  exact: boolean;
  featureTypeHint: FeatureType | null;
  jurisdictionHint: string | null;
  vintageHint: string | null;
}

export interface ScoreBreakdown {
  total: number;
  name: number;
  authority: number;
  aliasKind: number;
  typeHint: number;
  jurisdictionHint: number;
  vintageHint: number;
}

/**
 * Weights. Name similarity dominates: no amount of authority should float a source's
 * wrong feature above another source's right one.
 */
const W = { name: 0.55, authority: 0.18, aliasKind: 0.09, typeHint: 0.1, jurisdiction: 0.05, vintage: 0.03 };

export function scoreCandidate(input: ScoreInput): ScoreBreakdown {
  const name = input.exact ? 1 : Math.max(0, Math.min(1, input.nameScore));
  const authority = authorityScore(input.featureType, input.source);
  const aliasKind = aliasKindScore(input.aliasKind);

  // Hints are a preference, not a filter, at this stage: a hint the parser guessed wrong
  // must not be able to bury the correct feature.
  const typeHint = input.featureTypeHint === null ? 0.6 : input.featureTypeHint === input.featureType ? 1 : 0;
  const jurisdictionHint =
    input.jurisdictionHint === null ? 0.6 : input.jurisdictionHint === input.jurisdiction ? 1 : 0.1;

  let vintageHint = 0.6;
  if (input.vintageHint) {
    const v = (input.source.vintage ?? '').toLowerCase();
    vintageHint = v.includes(input.vintageHint.toLowerCase()) ? 1 : 0.2;
  }

  const total =
    W.name * name +
    W.authority * authority +
    W.aliasKind * aliasKind +
    W.typeHint * typeHint +
    W.jurisdiction * jurisdictionHint +
    W.vintage * vintageHint;

  return {
    total: Number(total.toFixed(4)),
    name,
    authority,
    aliasKind,
    typeHint,
    jurisdictionHint,
    vintageHint,
  };
}

/** Human-readable reason for a ranking, shown in the UI so a choice is explainable. */
export function explain(featureType: FeatureType, source: SourceFacts, b: ScoreBreakdown): string {
  const bits: string[] = [];
  if (b.name === 1) bits.push('exact name match');
  else if (b.name > 0.85) bits.push('close name match');
  else bits.push('partial name match');

  const wanted = AUTHORITY_FOR_TYPE[featureType];
  if (wanted && b.authority === 1) bits.push(`authoritative source (${wanted})`);
  else if (wanted && b.authority < 1) bits.push(`secondary source for this type`);

  if (b.typeHint === 1) bits.push('type matches the request');
  if (b.jurisdictionHint === 1) bits.push('jurisdiction matches');
  if (b.vintageHint === 1 && source.vintage) bits.push(`vintage ${source.vintage}`);
  return bits.join(', ');
}
