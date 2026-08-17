/**
 * The closed `feature_type` vocabulary.
 *
 * Every ingested layer maps to exactly one of these. This list is the single source of
 * truth: the DB CHECK constraint, the Claude system prompt enum, and the UI filters are
 * all generated from it. Add a new value ONLY by editing this file -- a value that is
 * not here will be rejected at ingest.
 */

export const FEATURE_TYPE_GROUPS = {
  political: [
    'country',
    'province_territory',
    'federal_electoral_district',
    'provincial_electoral_district',
    'census_division',
    'census_subdivision',
    'municipality',
    'municipal_ward',
    'regional_district',
  ],
  statistical: [
    'census_metropolitan_area',
    'census_agglomeration',
    'census_tract',
    'population_centre',
    'dissemination_area',
    'economic_region',
  ],
  indigenous: [
    'indian_reserve',
    'land_claim_settlement',
    'treaty_area',
    'inuit_region',
    'metis_settlement',
    'first_nation_community',
  ],
  service: [
    'health_region',
    'school_board',
    'forward_sortation_area',
    'police_jurisdiction',
    'fire_service_area',
    'emergency_management_zone',
  ],
  physical: [
    'watershed',
    'drainage_basin',
    'ecozone',
    'national_park',
    'provincial_park',
    'protected_area',
    'great_lake',
    'major_river',
  ],
  infrastructure: ['airport', 'port', 'rail_line', 'highway', 'transit_system'],
} as const;

export type FeatureTypeGroup = keyof typeof FEATURE_TYPE_GROUPS;

/** Harvest priority, M1 -> M7. Political and Indigenous layers come first. */
export const GROUP_PRIORITY: readonly FeatureTypeGroup[] = [
  'political',
  'indigenous',
  'statistical',
  'service',
  'physical',
  'infrastructure',
];

export const FEATURE_TYPES = GROUP_PRIORITY.flatMap((g) => FEATURE_TYPE_GROUPS[g] as readonly string[]);

export type FeatureType = (typeof FEATURE_TYPE_GROUPS)[FeatureTypeGroup][number];

const FEATURE_TYPE_SET: ReadonlySet<string> = new Set(FEATURE_TYPES);

export function isFeatureType(value: unknown): value is FeatureType {
  return typeof value === 'string' && FEATURE_TYPE_SET.has(value);
}

/** Throws rather than silently ingesting an untyped layer. */
export function assertFeatureType(value: unknown, context: string): FeatureType {
  if (!isFeatureType(value)) {
    throw new Error(
      `Unknown feature_type ${JSON.stringify(value)} at ${context}. ` +
        `The taxonomy is closed -- add the value to src/shared/taxonomy.ts if it is genuinely new.`,
    );
  }
  return value;
}

export function groupOf(type: FeatureType): FeatureTypeGroup {
  for (const g of GROUP_PRIORITY) {
    if ((FEATURE_TYPE_GROUPS[g] as readonly string[]).includes(type)) return g;
  }
  throw new Error(`unreachable: ${type} is in no group`);
}

/** Human labels for the UI. Kept terse -- the panes are dense by design. */
export const FEATURE_TYPE_LABELS: Record<FeatureType, string> = {
  country: 'Country',
  province_territory: 'Province / Territory',
  federal_electoral_district: 'Federal riding',
  provincial_electoral_district: 'Provincial riding',
  census_division: 'Census division',
  census_subdivision: 'Census subdivision',
  municipality: 'Municipality',
  municipal_ward: 'Municipal ward',
  regional_district: 'Regional district',
  census_metropolitan_area: 'Census metropolitan area',
  census_agglomeration: 'Census agglomeration',
  census_tract: 'Census tract',
  population_centre: 'Population centre',
  dissemination_area: 'Dissemination area',
  economic_region: 'Economic region',
  indian_reserve: 'Indian reserve',
  land_claim_settlement: 'Land claim settlement',
  treaty_area: 'Treaty area',
  inuit_region: 'Inuit region',
  metis_settlement: 'Métis settlement',
  first_nation_community: 'First Nation community',
  health_region: 'Health region',
  school_board: 'School board',
  forward_sortation_area: 'Forward sortation area',
  police_jurisdiction: 'Police jurisdiction',
  fire_service_area: 'Fire service area',
  emergency_management_zone: 'Emergency management zone',
  watershed: 'Watershed',
  drainage_basin: 'Drainage basin',
  ecozone: 'Ecozone',
  national_park: 'National park',
  provincial_park: 'Provincial park',
  protected_area: 'Protected area',
  great_lake: 'Great Lake',
  major_river: 'Major river',
  airport: 'Airport',
  port: 'Port',
  rail_line: 'Rail line',
  highway: 'Highway',
  transit_system: 'Transit system',
};

/**
 * Jurisdiction codes moved to ./jurisdictions when the catalog stopped being Canadian.
 *
 * They are re-exported here because the taxonomy is where the rest of the app expects to
 * find the closed vocabularies, but the jurisdiction set is no longer closed and no
 * longer fits alongside feature types. See ./jurisdictions for why the Canadian codes
 * are now prefixed.
 */
export {
  CANADA_BBOX,
  CANADA_JURISDICTIONS,
  CANADA_SUBDIVISION_LABELS,
  isJurisdiction,
  parseJurisdiction,
  WORLD_BBOX,
  type Jurisdiction,
} from './jurisdictions';
