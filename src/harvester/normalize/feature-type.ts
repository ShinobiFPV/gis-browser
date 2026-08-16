import { assertFeatureType, type FeatureType } from '@shared/taxonomy';

/**
 * Per-row feature_type refinement.
 *
 * A few sources pack several taxonomy types into one layer. The registry records the
 * dominant type; these rules split individual rows onto the right one at ingest. Anything
 * not covered here keeps the source's declared type.
 *
 * The mappings below come from the distinct values actually present in the live layers,
 * not from documentation.
 */

/** NRCan CLSS `distributionTypeEng`, as observed on the Aboriginal Lands layer. */
const CLSS_DISTRIBUTION_TYPE: Record<string, FeatureType> = {
  'Indian Reserve': 'indian_reserve',
  'Indian Land': 'indian_reserve',
  'Inuit Owned Land': 'inuit_region',
  'Inuvialuit Land': 'inuit_region',
  'Gwich’in Land': 'land_claim_settlement',
  "Gwich'in Land": 'land_claim_settlement',
  'Sahtu Land': 'land_claim_settlement',
  'Tlicho Land': 'land_claim_settlement',
  'Sechelt Land': 'land_claim_settlement',
  'Salt River First Nation Settlement Land': 'land_claim_settlement',
  'Cree and Naskapi 1A and 1A-N Land': 'land_claim_settlement',
  'Yukon First Nations Settlement Land': 'land_claim_settlement',
};

export interface RefineContext {
  declaredType: FeatureType;
  endpoint: string;
  attributes: Record<string, unknown>;
}

export function refineFeatureType(ctx: RefineContext): FeatureType {
  const { declaredType, endpoint, attributes } = ctx;

  // NRCan Canada Lands Survey System administrative boundaries.
  if (endpoint.includes('CLSS')) {
    const dt = attributes['distributionTypeEng'];
    if (typeof dt === 'string') {
      const mapped = CLSS_DISTRIBUTION_TYPE[dt.trim()];
      if (mapped) return assertFeatureType(mapped, `CLSS distributionTypeEng="${dt}"`);
      // An unmapped value means NRCan added a land type we have not classified. Keep the
      // declared type but make it visible rather than pretending it is a reserve.
      console.warn(`[normalize] unmapped CLSS distributionTypeEng "${dt}", keeping ${declaredType}`);
    }
  }

  // StatCan combines metropolitan areas and agglomerations in one layer.
  if (declaredType === 'census_metropolitan_area') {
    const t = attributes['CMATYPE'];
    if (typeof t === 'string' && t.trim().toUpperCase() === 'D') return 'census_agglomeration';
  }

  return declaredType;
}
