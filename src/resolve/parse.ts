import { type FeatureType, type Jurisdiction } from '@shared/taxonomy';
import { LEGACY_CANADIAN_CODES } from '@shared/jurisdictions';
import { normalizeText } from '../harvester/normalize/aliases';

/**
 * Keyword prompt parser.
 *
 * This is the fallback the brief calls for when Claude is unavailable or its JSON fails
 * validation -- and it is what the whole M3 acceptance test runs on, since the LLM is
 * switched off entirely there. It has to turn
 *
 *   "Give me the outline shape for Parry Island First Nation"
 *
 * into a searchable place name plus whatever hints are recoverable, without an LLM.
 */

export interface ParsedQuery {
  /** Candidate name strings to search, best first. */
  placeNames: string[];
  featureTypeHint: FeatureType | null;
  jurisdictionHint: Jurisdiction | null;
  vintageHint: string | null;
  wants: string;
  notes: string;
  via: 'keyword' | 'llm';
}

/**
 * Phrases that identify a feature type. Longest first, because "provincial electoral
 * district" must win over "electoral district" and "federal riding" over "riding".
 */
/**
 * Exported so discovery classifies a dataset title with the same vocabulary the search
 * parser uses. Two lists would drift, and a dataset filed under a type nobody searches
 * for is invisible however well it was crawled.
 */
export const TYPE_PHRASES: [string, FeatureType][] = [
  ['provincial electoral district', 'provincial_electoral_district'],
  ['provincial electoral districts', 'provincial_electoral_district'],
  // What the provinces actually call their own ridings. Saskatchewan, Alberta and
  // Manitoba say "constituency"; Manitoba and the Northwest Territories say "electoral
  // division"; Yukon says "electoral district" and means the territorial one.
  ['provincial constituency', 'provincial_electoral_district'],
  ['provincial constituencies', 'provincial_electoral_district'],
  ['electoral division', 'provincial_electoral_district'],
  ['electoral divisions', 'provincial_electoral_district'],
  ['legislative assembly', 'provincial_electoral_district'],
  ['constituency', 'provincial_electoral_district'],
  ['constituencies', 'provincial_electoral_district'],
  ['federal electoral district', 'federal_electoral_district'],
  ['federal electoral districts', 'federal_electoral_district'],
  ['census metropolitan area', 'census_metropolitan_area'],
  ['census metropolitan areas', 'census_metropolitan_area'],
  ['forward sortation area', 'forward_sortation_area'],
  ['census agglomeration', 'census_agglomeration'],
  ['dissemination area', 'dissemination_area'],
  ['census subdivision', 'census_subdivision'],
  ['land claim settlement', 'land_claim_settlement'],
  ['population centre', 'population_centre'],
  ['population center', 'population_centre'],
  ['electoral district', 'federal_electoral_district'],
  ['provincial riding', 'provincial_electoral_district'],
  ['regional district', 'regional_district'],
  ['census division', 'census_division'],
  ['economic region', 'economic_region'],
  ['indian reserve', 'indian_reserve'],
  ['federal riding', 'federal_electoral_district'],
  ['provincial park', 'provincial_park'],
  ['protected area', 'protected_area'],
  ['emergency zone', 'emergency_management_zone'],
  ['municipal ward', 'municipal_ward'],
  ['national park', 'national_park'],
  ['school district', 'school_board'],
  ['health region', 'health_region'],
  ['first nation', 'indian_reserve'],
  ['census tract', 'census_tract'],
  ['school board', 'school_board'],
  ['health unit', 'health_region'],
  ['inuit region', 'inuit_region'],
  ['metis settlement', 'metis_settlement'],
  ['treaty area', 'treaty_area'],
  ['municipality', 'municipality'],
  ['postal code', 'forward_sortation_area'],
  ['territory', 'province_territory'],
  ['watershed', 'watershed'],
  ['province', 'province_territory'],
  ['reserve', 'indian_reserve'],
  ['riding', 'federal_electoral_district'],
  ['ecozone', 'ecozone'],
  ['airport', 'airport'],
];

/** Short forms that only count as a type hint when they stand alone as a word. */
const TYPE_ABBREVIATIONS: [string, FeatureType][] = [
  ['fed', 'federal_electoral_district'],
  ['ped', 'provincial_electoral_district'],
  ['csd', 'census_subdivision'],
  ['cma', 'census_metropolitan_area'],
  ['fsa', 'forward_sortation_area'],
];

const PROVINCE_PHRASES: [string, Jurisdiction][] = [
  ['newfoundland and labrador', 'CA-NL'],
  ['northwest territories', 'CA-NT'],
  ['prince edward island', 'CA-PE'],
  ['british columbia', 'CA-BC'],
  ['nova scotia', 'CA-NS'],
  ['new brunswick', 'CA-NB'],
  ['saskatchewan', 'CA-SK'],
  ['newfoundland', 'CA-NL'],
  ['manitoba', 'CA-MB'],
  ['nunavut', 'CA-NU'],
  ['ontario', 'CA-ON'],
  ['alberta', 'CA-AB'],
  ['quebec', 'CA-QC'],
  ['yukon', 'CA-YT'],
];

/** Request boilerplate that carries no information about which place is wanted. */
const LEAD_INS = [
  'can you please give me',
  'can you give me',
  'please give me',
  'i would like',
  'could you get',
  'give me the',
  'show me the',
  'i need the',
  'get me the',
  'pull up the',
  'i want the',
  'give me',
  'show me',
  'i need',
  'get me',
  'i want',
  'please',
];

const TRAILING_WANTS = [
  'outline shape for',
  'outline shape of',
  'boundary shape for',
  'the outline shape',
  'outline for',
  'outline of',
  'boundary for',
  'boundary of',
  'borders of',
  'border of',
  'shape for',
  'shape of',
  'outline',
  'boundary',
  'shape',
  'map of',
];

function stripPhrases(text: string, phrases: string[]): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of phrases) {
      if (out.startsWith(`${p} `)) {
        out = out.slice(p.length + 1).trim();
        changed = true;
        break;
      }
      if (out === p) {
        out = '';
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Removes leading articles and dangling prepositions left behind by phrase removal. */
function tidy(text: string): string {
  // Collapse and trim FIRST: phrase removal leaves a leading space, which would stop the
  // article/preposition anchors below from matching.
  let out = text.replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    const next = out
      .replace(/^(?:the|a|an|of|for|in|at|to)\s+/, '')
      .replace(/\s+(?:of|for|in|the)$/, '')
      .trim();
    if (next !== out) {
      out = next;
      changed = true;
    }
  }
  return out;
}

function detectType(text: string): { type: FeatureType; phrase: string } | null {
  for (const [phrase, type] of TYPE_PHRASES) {
    if (new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`).test(text)) {
      return { type, phrase };
    }
  }
  for (const [abbr, type] of TYPE_ABBREVIATIONS) {
    if (new RegExp(`(?:^|\\s)${abbr}(?:$|\\s)`).test(text)) return { type, phrase: abbr };
  }
  return null;
}

function detectJurisdiction(text: string): { code: Jurisdiction; phrase: string } | null {
  for (const [phrase, code] of PROVINCE_PHRASES) {
    if (new RegExp(`(?:^|\\s)${phrase}(?:$|\\s)`).test(text)) return { code, phrase };
  }
  /*
   * Bare provincial abbreviations, only when they stand alone: "in ON", "BC ridings".
   *
   * These are mapped to their prefixed form rather than used as-is, because a bare code
   * now means a COUNTRY. Typing "NL ridings" in a Canadian newsroom means Newfoundland,
   * so it resolves to CA-NL; the Netherlands is reached by name, not by an abbreviation
   * nobody types in this context.
   */
  const m = /(?:^|\s)(ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt)(?:$|\s)/i.exec(text);
  if (m?.[1]) {
    const code = LEGACY_CANADIAN_CODES[m[1].toUpperCase()];
    if (code) return { code, phrase: m[1] };
  }
  return null;
}

function detectVintage(text: string): string | null {
  const order = /\b((?:19|20)\d{2})\s+representation order\b/.exec(text);
  if (order?.[1]) return `${order[1]} representation order`;
  const year = /\b((?:19|20)\d{2})\b/.exec(text);
  return year?.[1] ?? null;
}

function removePhrase(text: string, phrase: string): string {
  return tidy(text.replace(new RegExp(`(?:^|\\s)${phrase}(?:$|\\s)`, 'g'), ' '));
}

/**
 * Parses a plain-language request.
 *
 * `placeNames` is deliberately a LIST rather than one string. "Parry Island First Nation"
 * contains a type phrase that is also part of the name, while "the federal riding of
 * Parry Sound-Muskoka" contains one that is not. Rather than guess which, we emit both
 * the qualified and the stripped form and let the matcher try each -- a wrong guess then
 * costs nothing.
 */
export function parsePrompt(input: string): ParsedQuery {
  const normalized = normalizeText(input);
  const notes: string[] = [];

  const afterLeadIn = tidy(stripPhrases(normalized, LEAD_INS));
  const afterWants = tidy(stripPhrases(afterLeadIn, TRAILING_WANTS));

  const jur = detectJurisdiction(afterWants);
  const withoutJur = jur ? removePhrase(afterWants, jur.phrase) : afterWants;

  const type = detectType(withoutJur);
  const withoutType = type ? removePhrase(withoutJur, type.phrase) : withoutJur;

  const vintage = detectVintage(afterWants);
  const withoutVintage = vintage ? tidy(withoutType.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+representation order\b/g, ' ')) : withoutType;

  // Best first: most-stripped, then progressively less, then the raw text.
  const names = [withoutVintage, withoutType, withoutJur, afterWants, afterLeadIn, normalized]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  const placeNames = [...new Set(names)];

  if (type) notes.push(`type "${type.phrase}"`);
  if (jur) notes.push(`jurisdiction "${jur.phrase}"`);
  if (vintage) notes.push(`vintage "${vintage}"`);

  return {
    placeNames,
    featureTypeHint: type?.type ?? null,
    jurisdictionHint: jur?.code ?? null,
    vintageHint: vintage,
    wants: 'outline',
    notes: notes.length ? `keyword parser recognised ${notes.join(', ')}` : 'keyword parser found no hints',
    via: 'keyword',
  };
}
