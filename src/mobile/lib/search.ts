import { parsePrompt, type ParsedQuery } from '@resolve/parse';
import { explain, scoreCandidate } from '@resolve/rank';
import { isSubstantiveLooseMatch, tokensOf } from '@resolve/resolve';
import type { FeatureType } from '@shared/taxonomy';
import { normalizeText } from '../../harvester/normalize/aliases';
import type { Catalog, MobileFeature } from './catalog';

/**
 * Search, without SQLite.
 *
 * The desktop resolves in three passes -- FTS5 with every token required, FTS5 with tokens
 * optional, then bounded Levenshtein -- unioned and ranked. A phone has no FTS5, so the
 * first two passes are rebuilt here over an inverted token index held in memory. The third
 * is not rebuilt at all: FuzzyIndex is already plain TypeScript and is imported verbatim.
 *
 * What is deliberately identical to the desktop:
 *   - the parser (@resolve/parse), so the same typed sentence yields the same hints
 *   - the loose-match gate (isSubstantiveLooseMatch), so the OR pass cannot return every
 *     alias sharing one throwaway word
 *   - the ranker (@resolve/rank), so the same candidate set comes back in the same order
 *   - soft filtering: a filter that empties the result is dropped and the fact reported
 *
 * What differs, and why: an FTS5 prefix match is a b-tree seek, and here it is a scan of a
 * sorted token array. That is affordable because the mobile index is Tier A only -- tens of
 * thousands of aliases, not the millions a full desktop harvest reaches.
 */

export interface MobileCandidate {
  feature: MobileFeature;
  /** 0..1 from the shared ranker. */
  matchScore: number;
  matchedAlias: string;
  matchedVia: MatchVia;
  justification: string;
}

export type MatchVia = 'exact' | 'token' | 'loose' | 'fuzzy';

export interface SearchResult {
  candidates: MobileCandidate[];
  parsed: ParsedQuery;
  /** Non-fatal things worth saying out loud, e.g. that a filter was ignored. */
  notes: string[];
  elapsedMs: number;
}

export interface SearchOptions {
  featureTypeFilter?: FeatureType | null;
  jurisdictionFilter?: string | null;
  limit?: number;
}

/**
 * The inverted index, built once per catalog.
 *
 * Alias-level rather than feature-level, because the score depends on WHICH alias matched:
 * "Sarnia" against the alias "sarnia" is an exact hit, and against "sarnia 45" is a partial
 * one. Collapsing to features first would throw that away before it could be used.
 */
interface TokenIndex {
  /** Normalised alias text, one entry per distinct string. */
  aliases: string[];
  /** Features carrying alias `i`. The same name legitimately belongs to several. */
  aliasFeatures: number[][];
  /** token -> indices into `aliases`. */
  postings: Map<string, number[]>;
  /** `aliases`, sorted, for prefix expansion of the final token. */
  sortedTokens: string[];
  /** Normalised alias text -> index, so a fuzzy hit can be scored like any other. */
  aliasIndex: Map<string, number>;
}

/**
 * One index per catalog object. A WeakMap rather than a module-level variable so that
 * reloading the catalog (a new build arriving while the app is open) cannot leave a stale
 * index behind, and so the old one is collectable.
 */
const indexes = new WeakMap<Catalog, TokenIndex>();

function indexFor(catalog: Catalog): TokenIndex {
  const existing = indexes.get(catalog);
  if (existing) return existing;

  const aliases: string[] = [];
  const aliasFeatures: number[][] = [];
  const postings = new Map<string, number[]>();
  const aliasIndex = new Map<string, number>();

  for (const [text, featureIds] of catalog.byAlias) {
    const i = aliases.length;
    aliases.push(text);
    // The catalog pushes one entry per alias, so a feature whose official name and one of
    // its aliases normalise identically appears twice. Dedupe here rather than there --
    // the raw lists are also what the exact pass reads.
    aliasFeatures.push([...new Set(featureIds)]);
    aliasIndex.set(text, i);

    for (const token of new Set(tokensOf(text))) {
      const list = postings.get(token);
      if (list) list.push(i);
      else postings.set(token, [i]);
    }
  }

  const built: TokenIndex = {
    aliases,
    aliasFeatures,
    postings,
    sortedTokens: [...postings.keys()].sort(),
    aliasIndex,
  };
  indexes.set(catalog, built);
  return built;
}

/** Index of the first token at or after `prefix`. Plain binary search over sorted strings. */
function lowerBound(sorted: string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Alias indices for a token, treating the final token of a query as a prefix.
 *
 * The prefix expansion is capped. Typing "s" matches thousands of tokens, and unioning all
 * of their postings on every keystroke is work whose only possible outcome is a result list
 * too long to be a result. The cap is generous enough that a real word is never truncated
 * and small enough that a single letter cannot stall the main thread.
 */
const MAX_PREFIX_TOKENS = 400;

function postingsFor(index: TokenIndex, token: string, prefix: boolean): number[] {
  const exact = index.postings.get(token) ?? [];
  if (!prefix) return exact;

  const out = new Set(exact);
  let n = 0;
  for (let i = lowerBound(index.sortedTokens, token); i < index.sortedTokens.length; i++) {
    const candidate = index.sortedTokens[i]!;
    if (!candidate.startsWith(token)) break;
    if (++n > MAX_PREFIX_TOKENS) break;
    for (const a of index.postings.get(candidate)!) out.add(a);
  }
  return [...out];
}

interface Hit {
  aliasIdx: number;
  featureId: number;
  nameScore: number;
  exact: boolean;
  via: MatchVia;
}

/** Caps the work a single query may do, so a one-letter query cannot lock up a phone. */
const MAX_ALIAS_HITS = 4000;

export function search(catalog: Catalog, prompt: string, opts: SearchOptions = {}): SearchResult {
  const started = performance.now();
  const index = indexFor(catalog);
  const notes: string[] = [];

  const parsed = parsePrompt(prompt);

  // An explicit UI filter beats anything the parser inferred from the words.
  const typeFilter = opts.featureTypeFilter ?? parsed.featureTypeHint;
  const jurFilter = opts.jurisdictionFilter ?? parsed.jurisdictionHint;

  const byAlias = new Map<number, Hit>();
  const consider = (aliasIdx: number, nameScore: number, exact: boolean, via: MatchVia): void => {
    if (byAlias.size >= MAX_ALIAS_HITS && !byAlias.has(aliasIdx)) return;
    const held = byAlias.get(aliasIdx);
    if (held && held.nameScore >= nameScore) return;
    // featureId is filled in when hits collapse to features; one alias can carry several.
    byAlias.set(aliasIdx, { aliasIdx, featureId: -1, nameScore, exact, via });
  };

  const normalizedNames = parsed.placeNames.map((n) => normalizeText(n)).filter(Boolean);

  for (const [i, name] of parsed.placeNames.entries()) {
    const normalized = normalizeText(name);
    if (!normalized) continue;

    // Later variants are less specific, so their matches start from a lower name score.
    const variantPenalty = i === 0 ? 0 : Math.min(0.15, 0.05 * i);
    const queryTokens = tokensOf(name);
    if (queryTokens.length === 0) continue;

    // Pass 1: the whole query IS an alias. Cheapest possible hit and the strongest.
    const exactIdx = index.aliasIndex.get(normalized);
    if (exactIdx !== undefined) consider(exactIdx, 1 - variantPenalty, true, 'exact');

    // Pass 2: every token required, the last one as a prefix so the list narrows while
    // typing rather than only once a word is finished.
    const perToken = queryTokens.map((t, j) => postingsFor(index, t, j === queryTokens.length - 1));
    let intersection: number[] = [];
    if (perToken.length > 0 && perToken.every((p) => p.length > 0)) {
      // Intersect smallest-first: the rarest token bounds the work for all the others.
      const ordered = [...perToken].sort((a, b) => a.length - b.length);
      let acc = new Set(ordered[0] ?? []);
      for (const list of ordered.slice(1)) {
        const other = new Set(list);
        acc = new Set([...acc].filter((a) => other.has(a)));
        if (acc.size === 0) break;
      }
      intersection = [...acc];
    }

    for (const aliasIdx of intersection) {
      const aliasText = index.aliases[aliasIdx]!;
      const exact = normalizedNames.includes(aliasText);
      // How much of the alias the query actually accounted for. "sarnia" against "sarnia"
      // is everything; against "sarnia 45" it is most of it; against "sarnia no 45 indian
      // reserve" it is a fraction, and the score should say so.
      const coverage = aliasText.length === 0 ? 0 : Math.min(1, normalized.length / aliasText.length);
      const base = exact ? 1 : 0.82 * (0.6 + 0.4 * coverage);
      consider(aliasIdx, Math.max(0, base - variantPenalty), exact, exact ? 'exact' : 'token');
    }

    /*
     * Pass 3: tokens optional. This exists for one job -- a request carrying words the
     * official name does not have, like "Six Nations of the Grand River" against "SIX
     * NATIONS INDIAN RESERVE NO. 40" -- and it only runs on the most-stripped variant. On a
     * later variant it would match the designation words the stripping exists to remove,
     * turning "Wasauksing First Nation" into every First Nation in the catalog.
     */
    if (i === 0 && intersection.length === 0) {
      const union = new Set<number>();
      for (const list of perToken) for (const a of list) union.add(a);

      for (const aliasIdx of union) {
        const aliasText = index.aliases[aliasIdx]!;
        if (!isSubstantiveLooseMatch(queryTokens, aliasText)) continue;
        const coverage = aliasText.length === 0 ? 0 : Math.min(1, normalized.length / aliasText.length);
        consider(aliasIdx, Math.max(0, 0.6 * (0.6 + 0.4 * coverage)), false, 'loose');
      }
    }
  }

  // Pass 4: bounded Levenshtein, on the most specific variant only. This is the one pass
  // that can find a name nobody typed correctly.
  const fuzzyQuery = normalizedNames[0];
  if (fuzzyQuery && fuzzyQuery.length >= 3) {
    for (const hit of catalog.fuzzy.search(fuzzyQuery, { limit: 60 })) {
      const aliasIdx = index.aliasIndex.get(hit.text);
      if (aliasIdx === undefined) continue;
      consider(aliasIdx, hit.score * 0.95, hit.score === 1, hit.score === 1 ? 'exact' : 'fuzzy');
    }
  }

  // Collapse alias hits to one hit per feature, keeping the best-scoring alias.
  const byFeature = new Map<number, Hit>();
  for (const hit of byAlias.values()) {
    for (const featureId of index.aliasFeatures[hit.aliasIdx]!) {
      const held = byFeature.get(featureId);
      if (!held || hit.nameScore > held.nameScore) byFeature.set(featureId, { ...hit, featureId });
    }
  }

  let hits = [...byFeature.values()];

  /*
   * When the query matched something exactly, weak fuzzy hits are just noise. "Parry Island
   * First Nation" is two edits from "Avery Island" and "Bare Island", and without this the
   * top of the list is three-fifths wrong islands. If the name was typed correctly,
   * near-misses have nothing to offer; if it was mistyped, no exact match exists and the
   * fuzzy pass still carries the whole result.
   */
  if (hits.some((h) => h.exact)) {
    hits = hits.filter((h) => h.via !== 'fuzzy' || h.nameScore >= 0.9);
  }

  const featureOf = (h: Hit): MobileFeature | undefined => catalog.features.get(h.featureId);

  // Soft filtering: drop the filter rather than return nothing. The parser guesses, and a
  // guess must not be able to hide the right answer.
  const applyFilter = (list: Hit[], label: string, predicate: (h: Hit) => boolean): Hit[] => {
    const filtered = list.filter(predicate);
    if (filtered.length > 0) return filtered;
    if (list.length > 0) notes.push(`nothing matched the ${label} filter, so it was ignored`);
    return list;
  };

  if (typeFilter) hits = applyFilter(hits, 'type', (h) => featureOf(h)?.featureType === typeFilter);
  if (jurFilter) hits = applyFilter(hits, 'jurisdiction', (h) => featureOf(h)?.jurisdiction === jurFilter);

  const scored: MobileCandidate[] = [];
  for (const hit of hits) {
    const feature = featureOf(hit);
    if (!feature) continue;

    const sourceFacts = {
      jurisdiction: feature.jurisdiction,
      attribution: feature.source.attribution,
      vintage: feature.source.vintage,
    };

    const breakdown = scoreCandidate({
      featureType: feature.featureType,
      jurisdiction: feature.jurisdiction,
      source: sourceFacts,
      // The index does not ship alias_kind. It is one byte per alias for a 0.09-weighted
      // tiebreaker, and dropping it costs less than the megabytes it would add.
      aliasKind: null,
      nameScore: hit.nameScore,
      exact: hit.exact,
      featureTypeHint: typeFilter,
      jurisdictionHint: jurFilter ?? null,
      vintageHint: parsed.vintageHint,
    });

    scored.push({
      feature,
      matchScore: breakdown.total,
      matchedAlias: index.aliases[hit.aliasIdx]!,
      matchedVia: hit.via,
      justification: explain(feature.featureType, sourceFacts, breakdown),
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore || a.feature.name.localeCompare(b.feature.name));

  return {
    candidates: scored.slice(0, opts.limit ?? 25),
    parsed,
    notes,
    elapsedMs: Math.round(performance.now() - started),
  };
}
