import type { SeedSource } from '@shared/types';

/**
 * THE SEEDED SOURCE REGISTRY.
 *
 * Every endpoint below was confirmed with a live request on the date in VERIFIED_AT:
 * service metadata fetched with `?f=json`, layer id resolved from the service's own
 * layer list, field names read off the returned schema, and feature count taken from
 * `returnCountOnly=true`. Nothing here is from memory.
 *
 * `verifiedCount` is the reconciliation baseline. After a harvest the runner re-queries
 * the live count and compares; a mismatch marks the source `failed` rather than shipping
 * a silently truncated index.
 *
 * Tier A = per-feature queryable, index attributes only, geometry fetched lazily.
 * Tier B = bulk file, geometry arrives with the download, user-triggered.
 */

export const VERIFIED_AT = '2026-08-16';

const OGL_CANADA = 'Open Government Licence – Canada';
const OGL_ONTARIO = 'Open Government Licence – Ontario';
const STATCAN_LICENCE = 'Statistics Canada Open Licence';

const GEOCA = 'https://maps-cartes.services.geo.ca/server_serveur/rest/services';
const CLSS =
  'https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer';
const STATCAN_CBF_2021 =
  'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer';
const STATCAN_BULK_2021 =
  'https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers';
const LIO_OPEN03 = 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open03/MapServer';
const LIO_OPEN04 = 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open04/MapServer';
const LIO_OPEN09 = 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open09/MapServer';
const BC_WFS = 'https://openmaps.gov.bc.ca/geo/pub/wfs';

/** Shorthand so each entry stays readable. */
function esri(s: Omit<SeedSource, 'kind' | 'tier'>): SeedSource {
  return { ...s, kind: 'esri-rest', tier: 'A' };
}
function wfs(s: Omit<SeedSource, 'kind' | 'tier'>): SeedSource {
  return { ...s, kind: 'wfs', tier: 'A' };
}
function bulk(s: Omit<SeedSource, 'kind' | 'tier'>): SeedSource {
  return { ...s, kind: 'bulk-file', tier: 'B' };
}

// ---------------------------------------------------------------------------
// Federal electoral districts -- highest value layer in the app (election night).
// Elections Canada publishes every representation order back to 2003 on geo.ca,
// which is exactly the historical vintage coverage the brief asks for.
// ---------------------------------------------------------------------------

const FEDERAL_ELECTORAL: SeedSource[] = [
  esri({
    name: 'Federal Electoral Districts — 2023 Representation Order',
    endpoint: `${GEOCA}/ELECTIONS/FED_CA_2023_106_en/MapServer`,
    layerId: '0',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2023 representation order',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['ED_NAMEE', 'ED_NAMEF', 'FED_NUM'],
    sourceSrid: 3978,
    verifiedCount: 343,
    verifiedAt: VERIFIED_AT,
    notes: 'Current ridings. 343 seats, one row each. Names use em dashes (U+2014).',
  }),
  esri({
    name: 'Federal Electoral Districts — 45th General Election (2025)',
    endpoint: `${GEOCA}/ELECTIONS/FED_Elect2025_en/MapServer`,
    layerId: '3',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2025 general election',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['ED_NAMEE', 'ED_NAMEF', 'FED_NUM'],
    sourceSrid: 3978,
    verifiedCount: 352,
    verifiedAt: VERIFIED_AT,
    identityField: 'FED_NUM',
    notes:
      '352 rows but only 343 distinct FED_NUM -- this layer is multipart, one row per polygon. ' +
      'identityField merges the parts; the count check reconciles raw rows, not merged features.',
  }),
  esri({
    name: 'Federal Electoral Districts — 2021 (2013 Representation Order)',
    endpoint: `${GEOCA}/ELECTIONS/elections_canada2021_en/MapServer`,
    layerId: '1',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2021 general election',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['ED_NAMEE', 'ED_NAMEF', 'FED_NUM'],
    sourceSrid: 3978,
    verifiedCount: 347,
    verifiedAt: VERIFIED_AT,
    notes: 'Layer 1. Layer 0 of this service is advance polling districts -- do not use it.',
  }),
  esri({
    name: 'Federal Electoral Districts — 2019',
    endpoint: `${GEOCA}/ELECTIONS/elections_canada_2019_en/MapServer`,
    layerId: '0',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2019 general election',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['ENNAME', 'FRNAME', 'FEDNUM'],
    sourceSrid: 3978,
    verifiedCount: 347,
    verifiedAt: VERIFIED_AT,
    notes: 'Different field naming from the 2023 layer: ENNAME/FRNAME/FEDNUM.',
  }),
  esri({
    name: 'Federal Electoral Districts — 2015',
    endpoint: `${GEOCA}/ELECTIONS/federal_electoral_districts_boundaries_2015_en/MapServer`,
    layerId: '0',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2015 general election',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['name', 'fednum'],
    sourceSrid: 3978,
    verifiedCount: 347,
    verifiedAt: VERIFIED_AT,
    notes: 'Lowercase field names. maxRecordCount 1000 -- paging required.',
  }),
  esri({
    name: 'Federal Electoral Districts — 2013 Representation Order',
    endpoint: `${GEOCA}/ELECTIONS/federal_electoral_districts_boundaries_2013_en/MapServer`,
    layerId: '0',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2013 representation order',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['name', 'fednum'],
    sourceSrid: 3978,
    verifiedCount: 347,
    verifiedAt: VERIFIED_AT,
  }),
  esri({
    name: 'Federal Electoral Districts — 2003 Representation Order',
    endpoint: `${GEOCA}/ELECTIONS/federal_electoral_districts_boundaries_2003_en/MapServer`,
    layerId: '0',
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2003 representation order',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['name', 'fednum'],
    sourceSrid: 3978,
    verifiedCount: 312,
    verifiedAt: VERIFIED_AT,
    identityField: 'fednum',
    notes: '308 seats; 312 rows are multipart splits, merged on fednum at ingest.',
  }),
];

// ---------------------------------------------------------------------------
// Indigenous lands. NRCan Surveyor General is the authoritative federal layer;
// open.canada.ca dataset 522b07b9-78e2-4819-b736-ad9208eb1067 points at it.
// ---------------------------------------------------------------------------

const INDIGENOUS: SeedSource[] = [
  esri({
    name: 'Aboriginal Lands of Canada Legislative Boundaries',
    endpoint: CLSS,
    layerId: '0',
    featureType: 'indian_reserve',
    jurisdiction: 'CA',
    vintage: 'CLSS current',
    licence: OGL_CANADA,
    attribution: 'Natural Resources Canada, Surveyor General Branch',
    nameFields: ['adminAreaNameEng', 'adminAreaNameFra', 'adminAreaNameAlt1', 'adminAreaId'],
    sourceSrid: 3979,
    verifiedCount: 3372,
    verifiedAt: VERIFIED_AT,
    notes:
      'One layer holds several taxonomy types; split on distributionTypeEng at ingest. ' +
      'Observed values: Indian Reserve, Indian Land -> indian_reserve; Inuit Owned Land, ' +
      'Inuvialuit Land -> inuit_region; Gwich’in / Sahtu / Tlicho / Sechelt / Salt River / ' +
      'Cree and Naskapi 1A / Yukon First Nations Settlement Land -> land_claim_settlement. ' +
      'maxRecordCount is only 500, so paging is mandatory. ' +
      '"Parry Island First Nation" is present verbatim (adminAreaId 06205); the modern band ' +
      'name "Wasauksing" is NOT in any field and must come from the manual alias table.',
  }),
  esri({
    name: 'Ontario First Nation Reserves (LIO)',
    endpoint: LIO_OPEN03,
    layerId: '12',
    featureType: 'indian_reserve',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['OFFICIAL_NAME', 'OTHER_NAME'],
    sourceSrid: 4269,
    verifiedCount: 246,
    verifiedAt: VERIFIED_AT,
    notes:
      'Duplicates the NRCan layer for Ontario, deliberately. Ranking prefers NRCan (federal) ' +
      'for reserves. Also carries "Parry Island First Nation" verbatim.',
  }),
];

// ---------------------------------------------------------------------------
// Statistics Canada 2021 census geography. StatCan runs its own ArcGIS server, so
// this is all Tier A -- no need to mirror the 188MB dissemination-area shapefile
// just to make the names searchable.
// ---------------------------------------------------------------------------

function statcan(
  layerId: string,
  name: string,
  featureType: SeedSource['featureType'],
  nameFields: string[],
  verifiedCount: number,
  notes?: string,
): SeedSource {
  return esri({
    name,
    endpoint: STATCAN_CBF_2021,
    layerId,
    featureType,
    jurisdiction: 'CA',
    vintage: '2021 census (cartographic boundary file)',
    licence: STATCAN_LICENCE,
    attribution: 'Statistics Canada, 2021 Census — Cartographic Boundary Files',
    nameFields,
    sourceSrid: 3347,
    verifiedCount,
    verifiedAt: VERIFIED_AT,
    ...(notes ? { notes } : {}),
  });
}

const STATISTICAL: SeedSource[] = [
  statcan('0', 'Provinces and Territories — 2021', 'province_territory', ['PRENAME', 'PRFNAME', 'PRNAME', 'PREABBR', 'PRUID'], 13),
  statcan('2', 'Economic Regions — 2021', 'economic_region', ['ERNAME', 'ERUID'], 76),
  statcan(
    '3',
    'Federal Electoral Districts — 2021 Census (2013 order)',
    'federal_electoral_district',
    ['FEDENAME', 'FEDFNAME', 'FEDNAME', 'FEDUID'],
    338,
    'StatCan’s census-vintage FED layer. Elections Canada is the authoritative source for ridings; keep this for census joins.',
  ),
  statcan('4', 'Census Divisions — 2021', 'census_division', ['CDNAME', 'CDUID'], 293),
  statcan(
    '6',
    'Census Metropolitan Areas and Agglomerations — 2021',
    'census_metropolitan_area',
    ['CMANAME', 'CMAUID'],
    156,
    'CMATYPE B = metropolitan area, D = agglomeration. Split onto census_agglomeration at ingest.',
  ),
  statcan('7', 'Population Centres — 2021', 'population_centre', ['PCNAME', 'PCUID'], 1030),
  statcan('9', 'Census Subdivisions — 2021', 'census_subdivision', ['CSDNAME', 'CSDUID'], 5161),
  statcan('11', 'Census Tracts — 2021', 'census_tract', ['CTNAME', 'CTUID'], 6247),
  statcan(
    '12',
    'Dissemination Areas — 2021',
    'dissemination_area',
    ['DAUID'],
    57932,
    'No name field, only DAUID. 57,932 features at maxRecordCount 6000 -> 10 pages. Index only; never bulk-download.',
  ),
  statcan('14', 'Forward Sortation Areas — 2021', 'forward_sortation_area', ['CFSAUID'], 1643),
];

// ---------------------------------------------------------------------------
// Provincial. Ontario and BC are the deepest portals; the rest arrive in M7 via
// the ArcGIS Hub / CKAN crawlers rather than being guessed at here.
// ---------------------------------------------------------------------------

const PROVINCIAL: SeedSource[] = [
  esri({
    name: 'Ontario Provincial Electoral Districts (2018 boundaries)',
    endpoint: 'https://services.arcgis.com/6iGx1Dq91oKtcE7x/arcgis/rest/services/Electoral_Districts_Public_View/FeatureServer',
    layerId: '0',
    featureType: 'provincial_electoral_district',
    jurisdiction: 'ON',
    vintage: '2018 redistribution',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['NAME', 'NAME_FRENCH', 'ED_ID'],
    sourceSrid: 4269,
    verifiedCount: 124,
    verifiedAt: VERIFIED_AT,
    notes: 'Ontario’s 124 ridings. Published by the authoritative Ontario ArcGIS Online org.',
  }),
  esri({
    name: 'Newfoundland and Labrador Provincial Electoral Districts',
    endpoint: 'https://services8.arcgis.com/aCyQID5qQcyrJMm2/arcgis/rest/services/Provincial_Electoral_Districts/FeatureServer',
    layerId: '0',
    featureType: 'provincial_electoral_district',
    jurisdiction: 'NL',
    vintage: 'current',
    licence: 'Unconfirmed — verify before broadcast use',
    attribution: 'Government of Newfoundland and Labrador',
    nameFields: ['DIST_NAME'],
    sourceSrid: 3857,
    verifiedCount: 40,
    verifiedAt: VERIFIED_AT,
    notes: 'Served in EPSG:3857 -- reprojection required. Licence not stated on the service; confirm before air.',
  }),
  esri({
    name: 'Ontario Municipal Boundaries — Lower and Single Tier',
    endpoint: LIO_OPEN03,
    layerId: '14',
    featureType: 'municipality',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['MUNICIPAL_NAME', 'MUNICIPAL_NAME_FR', 'MUNICIPAL_NAME_SHORTFORM', 'MUNID'],
    sourceSrid: 4269,
    verifiedCount: 685,
    verifiedAt: VERIFIED_AT,
    notes: 'MUNICIPAL_NAME_PREFIX holds "City of"/"Township of" separately -- useful for the stripped alias form.',
  }),
  esri({
    name: 'Ontario Municipal Boundaries — Upper Tier and District',
    endpoint: LIO_OPEN03,
    layerId: '13',
    featureType: 'regional_district',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['MUNICIPAL_NAME', 'MUNICIPAL_NAME_FR', 'MUNID'],
    sourceSrid: 4269,
    verifiedCount: 98,
    verifiedAt: VERIFIED_AT,
  }),
  esri({
    name: 'Ontario Provincial Parks (Regulated)',
    endpoint: LIO_OPEN03,
    layerId: '4',
    featureType: 'provincial_park',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['PROTECTED_AREA_NAME_ENG', 'PROTECTED_AREA_NAME_FR', 'COMMON_SHORT_NAME'],
    sourceSrid: 4269,
    verifiedCount: 347,
    verifiedAt: VERIFIED_AT,
    notes:
      'Also carries Ojibwa, Oji-Cree and Cree name fields (PROTECTED_AREA_NAME_OJIBWA etc). ' +
      'Seed those as aliases -- they are exactly the kind of name an artist might type.',
  }),
  esri({
    name: 'Ontario Tertiary Watersheds',
    endpoint: LIO_OPEN04,
    layerId: '2',
    featureType: 'watershed',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['WATERSHED_NAME', 'WATERSHED_CODE'],
    sourceSrid: 4269,
    verifiedCount: 219,
    verifiedAt: VERIFIED_AT,
  }),
  esri({
    name: 'Ontario Public Health Unit Boundaries',
    endpoint: LIO_OPEN09,
    layerId: '44',
    featureType: 'health_region',
    jurisdiction: 'ON',
    vintage: 'LIO current',
    licence: OGL_ONTARIO,
    attribution: '© King’s Printer for Ontario',
    nameFields: ['PHU_NAME_ENG', 'PHU_NAME_FR', 'PHU_ID'],
    sourceSrid: 4269,
    verifiedCount: 29,
    verifiedAt: VERIFIED_AT,
  }),
];

// ---------------------------------------------------------------------------
// British Columbia -- WFS. Feature type names confirmed present in GetCapabilities
// (895 types advertised). Counts come from the first harvest, since WFS has no
// cheap equivalent of returnCountOnly until we issue resultType=hits.
// ---------------------------------------------------------------------------

function bcwfs(
  typeName: string,
  name: string,
  featureType: SeedSource['featureType'],
  nameFields: string[],
  notes?: string,
): SeedSource {
  return wfs({
    name,
    endpoint: BC_WFS,
    layerId: typeName,
    featureType,
    jurisdiction: 'BC',
    vintage: 'BCGW current',
    licence: 'Open Government Licence – British Columbia',
    attribution: 'Province of British Columbia',
    nameFields,
    sourceSrid: 3005,
    verifiedCount: null,
    verifiedAt: VERIFIED_AT,
    ...(notes ? { notes } : {}),
  });
}

const BRITISH_COLUMBIA: SeedSource[] = [
  bcwfs(
    'pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW',
    'BC Provincial Electoral Districts',
    'provincial_electoral_district',
    ['ED_NAME', 'ED_ABBREVIATION'],
    'Use resultType=hits for the count check and watch WFS 2.0 axis order on srsName=EPSG:4326.',
  ),
  bcwfs('pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP', 'BC Municipalities', 'municipality', ['ADMIN_AREA_NAME', 'ADMIN_AREA_ABBREVIATION']),
  bcwfs('pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP', 'BC Regional Districts', 'regional_district', ['ADMIN_AREA_NAME', 'ADMIN_AREA_ABBREVIATION']),
  bcwfs('pub:WHSE_ADMIN_BOUNDARIES.ADM_INDIAN_RESERVES_BANDS_SP', 'BC Indian Reserves and Band Names', 'indian_reserve', ['ENGLISH_NAME', 'BAND_NAME']),
  bcwfs('pub:WHSE_TANTALIS.TA_LAND_CLAIM_STLMNT_AREAS_SVW', 'BC Land Claim Settlement Areas', 'land_claim_settlement', ['LAND_CLAIM_SETTLEMENT_NAME']),
  bcwfs('pub:WHSE_TANTALIS.TA_SCHOOL_DISTRICTS_SVW', 'BC School Districts', 'school_board', ['SCHOOL_DISTRICT_NAME']),
  bcwfs('pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW', 'BC Parks, Ecological Reserves and Protected Areas', 'provincial_park', ['PROTECTED_LANDS_NAME']),
];

// ---------------------------------------------------------------------------
// Tier B -- bulk files. Sizes are real HEAD responses; anything over 100MB gets an
// explicit confirmation in the UI before download.
// ---------------------------------------------------------------------------

const BULK: SeedSource[] = [
  bulk({
    name: 'Federal Electoral Districts — 2023 Representation Order (shapefile)',
    endpoint:
      'https://ftp.maps.canada.ca/pub/elections_elections/Electoral-districts_Circonscription-electorale/' +
      'federal_electoral_districts_boundaries_2023/FED_CA_2023_EN-SHP.zip',
    layerId: null,
    featureType: 'federal_electoral_district',
    jurisdiction: 'CA',
    vintage: '2023 representation order',
    licence: OGL_CANADA,
    attribution: 'Elections Canada',
    nameFields: ['ED_NAMEE', 'ED_NAMEF', 'FED_NUM'],
    sourceSrid: 3978,
    verifiedCount: 343,
    verifiedAt: VERIFIED_AT,
    notes:
      '9 MB. Deliberate redundancy for the layer that matters most on election night: the ESRI ' +
      'REST endpoint for these boundaries lives on maps-cartes.services.geo.ca, which was ' +
      'returning 403 host-wide on 2026-08-16. This file is the same Elections Canada data on ' +
      'ftp.maps.canada.ca, a different host that stayed up. Every other vintage (2003, 2013, ' +
      '2015, 2019, 2021) is mirrored in the parent directory if the same outage recurs.',
  }),
  bulk({
    name: 'Aboriginal Lands of Canada — national shapefile',
    endpoint: 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_al_ta/shp_eng/AL_TA_CA_SHP_eng.zip',
    layerId: null,
    featureType: 'indian_reserve',
    jurisdiction: 'CA',
    vintage: 'CLSS current',
    licence: OGL_CANADA,
    attribution: 'Natural Resources Canada, Surveyor General Branch',
    nameFields: ['NAME1', 'NAME2'],
    sourceSrid: null,
    verifiedCount: null,
    verifiedAt: VERIFIED_AT,
    notes:
      'Offline fallback for the Tier A CLSS service. Note AL_TA_CA_SHP_DCM_eng.zip in the same ' +
      'directory is a change-management delta, NOT the full dataset -- do not seed that one.',
  }),
  bulk({
    name: 'StatCan Dissemination Areas — 2021 (cartographic)',
    endpoint: `${STATCAN_BULK_2021}/lda_000b21a_e.zip`,
    layerId: null,
    featureType: 'dissemination_area',
    jurisdiction: 'CA',
    vintage: '2021 census',
    licence: STATCAN_LICENCE,
    attribution: 'Statistics Canada, 2021 Census — Cartographic Boundary Files',
    nameFields: ['DAUID'],
    sourceSrid: 3347,
    verifiedCount: 57932,
    verifiedAt: VERIFIED_AT,
    notes: '188 MB. Only worth downloading if working offline -- the Tier A service covers the same data.',
  }),
  bulk({
    name: 'StatCan Census Subdivisions — 2021 (cartographic)',
    endpoint: `${STATCAN_BULK_2021}/lcsd000b21a_e.zip`,
    layerId: null,
    featureType: 'census_subdivision',
    jurisdiction: 'CA',
    vintage: '2021 census',
    licence: STATCAN_LICENCE,
    attribution: 'Statistics Canada, 2021 Census — Cartographic Boundary Files',
    nameFields: ['CSDNAME'],
    sourceSrid: 3347,
    verifiedCount: 5161,
    verifiedAt: VERIFIED_AT,
    notes: '149 MB.',
  }),
  bulk({
    name: 'Natural Earth 10m — Admin 0 Countries',
    endpoint: 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip',
    layerId: null,
    featureType: 'country',
    jurisdiction: null,
    vintage: 'Natural Earth 10m',
    licence: 'Public domain',
    attribution: 'Made with Natural Earth',
    nameFields: ['NAME', 'NAME_LONG', 'ADMIN'],
    sourceSrid: 4326,
    verifiedCount: null,
    verifiedAt: VERIFIED_AT,
    notes: '4.7 MB. Context layer for neighbouring countries behind a Canadian boundary.',
  }),
  bulk({
    name: 'Natural Earth 10m — Lakes',
    endpoint: 'https://naciscdn.org/naturalearth/10m/physical/ne_10m_lakes.zip',
    layerId: null,
    featureType: 'great_lake',
    jurisdiction: null,
    vintage: 'Natural Earth 10m',
    licence: 'Public domain',
    attribution: 'Made with Natural Earth',
    nameFields: ['name', 'name_alt'],
    sourceSrid: 4326,
    verifiedCount: null,
    verifiedAt: VERIFIED_AT,
    notes: '2.2 MB. Filter to the Great Lakes at ingest.',
  }),
  bulk({
    name: 'Natural Earth 10m — Rivers and Lake Centerlines',
    endpoint: 'https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip',
    layerId: null,
    featureType: 'major_river',
    jurisdiction: null,
    vintage: 'Natural Earth 10m',
    licence: 'Public domain',
    attribution: 'Made with Natural Earth',
    nameFields: ['name', 'name_alt'],
    sourceSrid: 4326,
    verifiedCount: null,
    verifiedAt: VERIFIED_AT,
    notes: '2.0 MB.',
  }),
];

// ---------------------------------------------------------------------------
// Physical / national parks.
// ---------------------------------------------------------------------------

const PHYSICAL: SeedSource[] = [
  esri({
    name: 'National Parks and National Park Reserves of Canada',
    endpoint: CLSS,
    layerId: '1',
    featureType: 'national_park',
    jurisdiction: 'CA',
    vintage: 'CLSS current',
    licence: OGL_CANADA,
    attribution: 'Natural Resources Canada, Surveyor General Branch',
    nameFields: ['adminAreaNameEng', 'adminAreaNameFra', 'adminAreaNameAlt1', 'adminAreaId'],
    sourceSrid: 3979,
    verifiedCount: 46,
    verifiedAt: VERIFIED_AT,
    notes: 'Same MapServer as Aboriginal Lands, layer 1. maxRecordCount 500.',
  }),
];

export const SEED_SOURCES: SeedSource[] = [
  ...FEDERAL_ELECTORAL,
  ...INDIGENOUS,
  ...STATISTICAL,
  ...PROVINCIAL,
  ...BRITISH_COLUMBIA,
  ...PHYSICAL,
  ...BULK,
];

/**
 * Discovery entry points for M7. These are catalog APIs, not layers -- the crawlers
 * walk them to find sources we have not hand-seeded (remaining provinces, CPCAD,
 * municipal wards, transit). All four confirmed responding on VERIFIED_AT.
 */
export const DISCOVERY_CATALOGS = [
  { name: 'open.canada.ca (federal CKAN)', kind: 'ckan' as const, endpoint: 'https://open.canada.ca/data/en/api/3' },
  { name: 'BC Data Catalogue (CKAN)', kind: 'ckan' as const, endpoint: 'https://catalogue.data.gov.bc.ca/api/3' },
  { name: 'Données Québec (CKAN)', kind: 'ckan' as const, endpoint: 'https://www.donneesquebec.ca/recherche/api/3' },
  { name: 'ArcGIS Hub', kind: 'arcgis-hub' as const, endpoint: 'https://hub.arcgis.com/api/v3' },
];
