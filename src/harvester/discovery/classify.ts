import type { FeatureType, Jurisdiction } from '@shared/taxonomy';
import type { SourceKind } from '@shared/types';
import { coverageOf, jurisdictionForExtent, PROVINCE_ALIASES, type LonLatBox } from '@shared/provinces';
import { TYPE_PHRASES } from '@resolve/parse';
import { normalizeText } from '../normalize/aliases';

/**
 * Turning a catalog entry into a proposed source.
 *
 * Everything here is a proposal, never a decision. Discovery finds candidates and says
 * what it thinks they are and what is wrong with them; a person accepts them. That split
 * exists because of what the Hub actually returns: a search for "provincial electoral
 * districts" puts the City of Brampton's five-riding municipal extract on the first page,
 * beside the genuine 40-riding Government of Newfoundland and Labrador layer. Auto-adding
 * the first would put five fake ridings into the search that decides what goes on air.
 */

export interface DiscoveredCandidate {
  catalog: 'arcgis-hub' | 'ckan';
  catalogId: string;
  title: string;
  endpoint: string;
  kind: SourceKind;
  publisher: string | null;
  extent: LonLatBox | null;
  recordCount: number | null;
  srid: number | null;
  fieldNames: string[];
  licence: string | null;
  description: string | null;

  featureType: FeatureType | null;
  jurisdiction: Jurisdiction | null;
  jurisdictionVia: 'title' | 'publisher' | 'extent' | 'none';
  nameFields: string[];
  /** 0..1. Everything below the accept threshold still gets shown, with its concerns. */
  confidence: number;
  /** Plain-language reasons to look closely. Never suppressed. */
  concerns: string[];
}

/**
 * ESRI system fields, plus the geometry columns. None can name a boundary.
 */
const SYSTEM_FIELD = /^(objectid|fid|globalid|shape|se_anno_cad_data|created?_?(date|user)|last_edited_?(date|user)|creator|editor|creationdate|editdate|st_area|st_length)/i;
const SYSTEM_SUFFIX = /(__area|__length|\.starea\(\)|\.stlength\(\)|_area|_length)$/i;

/** Field names that plausibly hold a human-readable name. Ordered by how good they are. */
const NAME_PATTERNS: RegExp[] = [
  /^(name|nom|nom_fr|name_en|name_fr)$/i,
  /^[a-z]{2,8}_?name[a-z]?$/i, // ED_NAME, DIST_NAME, CSDNAME, FEDENAME
  /name/i,
  /^(nom|libelle|designation|desig|label|title|titre)/i,
  /(_desc|description)$/i,
];

/**
 * Picks the fields worth indexing as names.
 *
 * ArcGIS Hub's `fieldNames` interleaves real field names with their display aliases --
 * ["ED_ID","Electoral District ID","NAME","Official Name"]. An alias is not a field and
 * querying one is an HTTP 400, so entries containing whitespace are dropped: ESRI field
 * names cannot contain spaces.
 */
export function pickNameFields(fieldNames: string[], limit = 3): string[] {
  const real = fieldNames.filter((f) => f && !/\s/.test(f) && !SYSTEM_FIELD.test(f) && !SYSTEM_SUFFIX.test(f));

  const scored: { field: string; rank: number }[] = [];
  for (const field of real) {
    const rank = NAME_PATTERNS.findIndex((p) => p.test(field));
    if (rank !== -1) scored.push({ field, rank });
  }

  scored.sort((a, b) => a.rank - b.rank || a.field.length - b.field.length);

  const out: string[] = [];
  for (const { field } of scored) {
    if (!out.includes(field)) out.push(field);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Matches a dataset title against the search parser's own type vocabulary.
 *
 * Longest phrase first, so "provincial electoral district" is not swallowed by
 * "electoral district" -- which maps to the FEDERAL type and would file every provincial
 * layer in the country under the wrong heading.
 */
export function classifyFeatureType(...texts: (string | null | undefined)[]): FeatureType | null {
  const byLength = [...TYPE_PHRASES].sort((a, b) => b[0].length - a[0].length);

  const match = (text: string | null | undefined): FeatureType | null => {
    const haystack = normalizeText(text ?? '');
    if (!haystack) return null;
    for (const [phrase, type] of byLength) {
      if (haystack.includes(normalizeText(phrase))) return type;
    }
    return null;
  };

  /*
   * Only the title is consulted. Tags and description are deliberately ignored.
   *
   * They were tried and they actively mislead. One Saskatchewan publisher tags every
   * layer identically, so its "Fishing Zones" came back as a health region on the first
   * attempt and as a provincial electoral district on the second -- the tags stayed the
   * same while the vocabulary shifted underneath them. Publisher boilerplate describes
   * the account, not the dataset.
   *
   * A title that names no boundary type yields null, which raises a concern and drops the
   * candidate down the list. "I could not tell what this is" is a true and useful answer;
   * a type borrowed from someone's tag cloud is neither.
   */
  return match(texts[0]);
}

/**
 * Works out which jurisdiction a dataset is about.
 *
 * Title first, then publisher, then geography. Text beats extent because an extent only
 * says where the data sits: Peel Region's provincial-riding extract sits inside Ontario
 * and is not the Ontario layer, and the title is what distinguishes them.
 */
export function inferJurisdiction(
  title: string,
  publisher: string | null,
  extent: LonLatBox | null,
): { jurisdiction: Jurisdiction | null; via: 'title' | 'publisher' | 'extent' | 'none' } {
  const inText = (text: string): Jurisdiction | null => {
    const norm = normalizeText(text);
    let best: { code: Jurisdiction; length: number } | null = null;
    for (const [code, aliases] of Object.entries(PROVINCE_ALIASES) as [Jurisdiction, string[]][]) {
      for (const alias of aliases) {
        // Word-boundary match, so "Ontario" does not fire inside another word.
        const pattern = new RegExp(`(^|[^a-z])${normalizeText(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
        if (pattern.test(norm) && (!best || alias.length > best.length)) {
          best = { code, length: alias.length };
        }
      }
    }
    return best?.code ?? null;
  };

  const fromTitle = inText(title);
  if (fromTitle) return { jurisdiction: fromTitle, via: 'title' };

  const fromPublisher = publisher ? inText(publisher) : null;
  if (fromPublisher) return { jurisdiction: fromPublisher, via: 'publisher' };

  if (extent) {
    const guess = jurisdictionForExtent(extent);
    if (guess) return { jurisdiction: guess.jurisdiction, via: 'extent' };
  }

  return { jurisdiction: null, via: 'none' };
}

/**
 * Types that describe a whole jurisdiction, so a dataset claiming one should cover it.
 *
 * A municipal ward layer legitimately covers one city; a provincial riding layer does not.
 */
const JURISDICTION_WIDE_TYPES = new Set<FeatureType>([
  'provincial_electoral_district',
  'federal_electoral_district',
  'census_division',
  'census_subdivision',
  'province_territory',
  'economic_region',
  'health_region',
]);

/** Below this fraction of its jurisdiction, a jurisdiction-wide layer is a local extract. */
export const MIN_COVERAGE = 0.3;

/**
 * Federal seats per jurisdiction under the 2023 representation order, totalling 343.
 *
 * Used to catch a specific and dangerous confusion. "Electoral district" with no
 * qualifier is the FEDERAL type in our vocabulary, but the provinces use the same words
 * for their own ridings, and the two are completely different boundaries. Yukon has one
 * federal seat: a Government of Yukon layer called "Yukon Electoral Districts" holding 21
 * features is unmistakably the territorial legislature's, not Parliament's. Counting is
 * the cheapest way to know, and putting territorial boundaries on air labelled federal is
 * exactly the class of error the brief is written against.
 */
export const FEDERAL_SEATS: Partial<Record<Jurisdiction, number>> = {
  NL: 7,
  PE: 4,
  NS: 11,
  NB: 10,
  QC: 78,
  ON: 122,
  MB: 14,
  SK: 14,
  AB: 37,
  BC: 43,
  YT: 1,
  NT: 1,
  NU: 1,
  CA: 343,
};

/**
 * Words that mark a publisher as an institution rather than a person.
 */
const OFFICIAL_PUBLISHER =
  /\b(government|gouvernement|ministry|ministère|ministere|department|elections|statistics|statistique|agency|authority|commission|bureau|province|city of|town of|county|region|municipality|district|first nation|crown|service|survey|natural resources|map hub|geohub|open data|opendata)\b/i;

/**
 * Marks of a personal ArcGIS Online account: an email address, or a bare handle with no
 * spaces at all.
 */
function looksPersonal(publisher: string): boolean {
  if (/@/.test(publisher)) return true;
  return !/\s/.test(publisher.trim());
}

export type PublisherKind = 'official' | 'personal' | 'unknown';

/**
 * Who published this.
 *
 * A real signal, not bookkeeping. ArcGIS Hub is full of government data re-uploaded to
 * individual accounts: New Brunswick's provincial ridings under "paulpeters",
 * Saskatchewan's constituencies under "Bunwee16", federal ridings under a university
 * email address. The geometry may well be fine, but a copy on a personal account has no
 * maintenance guarantee and no licence of record, and the brief is explicit that
 * provenance matters when a boundary goes to air. The official publisher of the same
 * layer should always win.
 */
/**
 * Government hosts. Who SERVES the data outranks who listed it in a catalog.
 *
 * Saskatchewan's 61 provincial constituencies are listed on ArcGIS Hub by an account
 * called "Bunwee16", which the name test rightly distrusts -- but the endpoint is
 * gis.saskatchewan.ca, the province's own GIS server. The layer is authoritative and the
 * Hub listing is just a pointer to it. Judging the account alone demoted the best
 * available source for an entire province.
 */
const GOVERNMENT_HOST =
  /(^|\.)(gc\.ca|canada\.ca|gov\.bc\.ca|alberta\.ca|saskatchewan\.ca|gov\.mb\.ca|ontario\.ca|gov\.on\.ca|gouv\.qc\.ca|gnb\.ca|novascotia\.ca|gov\.ns\.ca|gov\.pe\.ca|gov\.nl\.ca|gov\.yk\.ca|gov\.nt\.ca|gov\.nu\.ca)$/i;

export function isGovernmentHost(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  try {
    return GOVERNMENT_HOST.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function classifyPublisher(publisher: string | null, endpoint?: string | null): PublisherKind {
  if (isGovernmentHost(endpoint)) return 'official';
  if (!publisher?.trim()) return 'unknown';
  if (OFFICIAL_PUBLISHER.test(publisher)) return 'official';
  if (looksPersonal(publisher)) return 'personal';
  return 'unknown';
}

export interface AssessInput {
  title: string;
  featureType: FeatureType | null;
  jurisdiction: Jurisdiction | null;
  extent: LonLatBox | null;
  recordCount: number | null;
  nameFields: string[];
  licence: string | null;
  publisher: string | null;
  /** The service URL. Its host is stronger provenance than the catalog account name. */
  endpoint?: string | null;
  /** How the jurisdiction was arrived at. Geography alone is the weakest of the three. */
  jurisdictionVia?: 'title' | 'publisher' | 'extent' | 'none';
}

/**
 * Everything questionable about a candidate, and a confidence that falls with each.
 *
 * The concerns are the product here, not the number. A person deciding whether to trust a
 * boundary needs to read "covers 0.1% of Ontario", not "confidence 0.34".
 */
export function assess(input: AssessInput): { confidence: number; concerns: string[] } {
  const concerns: string[] = [];
  let confidence = 1;

  if (!input.featureType) {
    concerns.push('Could not work out what kind of boundary this is from its title.');
    confidence -= 0.4;
  }

  if (!input.jurisdiction) {
    concerns.push(
      'Could not work out which province or territory this covers, from its title, its ' +
        'publisher, or its extent.',
    );
    confidence -= 0.3;
  } else if (input.jurisdictionVia === 'extent') {
    // Nothing in the words said Canada; only the geography suggested it. That is how a
    // North Carolina layer ends up looking Ontarian.
    concerns.push(
      `Nothing in the title or publisher names a jurisdiction — ${input.jurisdiction} was ` +
        `inferred from the extent alone, which border-straddling datasets get wrong.`,
    );
    confidence -= 0.15;
  }

  if (input.nameFields.length === 0) {
    concerns.push(
      'No field looks like it holds a name, so these boundaries could not be searched for by name.',
    );
    confidence -= 0.5;
  }

  if (!input.extent) {
    concerns.push('The catalog publishes no extent, so its location could not be checked.');
    confidence -= 0.2;
  } else if (input.jurisdiction && input.featureType && JURISDICTION_WIDE_TYPES.has(input.featureType)) {
    const coverage = coverageOf(input.extent, input.jurisdiction);
    if (coverage < MIN_COVERAGE) {
      concerns.push(
        `Covers about ${(coverage * 100).toFixed(1)}% of ${input.jurisdiction}, but a ` +
          `${input.featureType.replace(/_/g, ' ')} layer should span the whole jurisdiction. ` +
          `This looks like a local extract published under a jurisdiction-wide title` +
          `${input.publisher ? ` by ${input.publisher}` : ''}.`,
      );
      confidence -= 0.5;
    }
  }

  if (input.recordCount !== null && input.recordCount <= 1) {
    concerns.push(`Holds ${input.recordCount} feature(s).`);
    confidence -= 0.2;
  }

  // Federal or provincial? The count settles it, and the words often do not.
  if (
    input.featureType === 'federal_electoral_district' &&
    input.jurisdiction &&
    input.recordCount !== null &&
    input.recordCount > 1
  ) {
    const seats = FEDERAL_SEATS[input.jurisdiction];
    if (seats !== undefined && Math.abs(input.recordCount - seats) > Math.max(3, seats * 0.15)) {
      concerns.push(
        `Classified as a federal electoral district layer for ${input.jurisdiction}, which has ` +
          `${seats} federal seat${seats === 1 ? '' : 's'} — but this holds ${input.recordCount} ` +
          `features. It is far more likely to be ${input.jurisdiction}'s own provincial or ` +
          `territorial ridings, which are different boundaries entirely.`,
      );
      confidence -= 0.45;
    }
  }

  const publisherKind = classifyPublisher(input.publisher, input.endpoint);
  if (publisherKind === 'personal') {
    concerns.push(
      `Published by "${input.publisher}", which looks like an individual account rather than ` +
        `an organisation. Probably a copy of someone else's data — prefer the official ` +
        `publisher's own layer if one exists.`,
    );
    confidence -= 0.25;
  } else if (publisherKind === 'official') {
    // The one thing that RAISES confidence, so an authoritative publisher outranks an
    // otherwise identical candidate when the validation budget is being spent.
    confidence += 0.1;
  }

  const licence = (input.licence ?? '').toLowerCase();
  if (!licence || licence === 'none' || licence === 'custom') {
    concerns.push('The catalog declares no usable licence. Check the terms before anything airs.');
    confidence -= 0.1;
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), concerns };
}
