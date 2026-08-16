import type { Db } from '@db/index';
import type { AliasKind, Candidate } from '@shared/types';
import type { FeatureType } from '@shared/taxonomy';
import { normalizeText } from '../harvester/normalize/aliases';
import { parsePrompt, type ParsedQuery } from './parse';
import { FuzzyIndex, type FuzzyEntry } from './fuzzy';
import { explain, scoreCandidate } from './rank';

/**
 * The resolve layer.
 *
 * Three passes, unioned, then ranked:
 *   1. FTS5 with every token required -- precise, and what an exactly-typed name hits.
 *   2. FTS5 with tokens optional -- catches a request carrying extra words the official
 *      name does not have ("Six Nations of the Grand River" vs "Six Nations 40").
 *   3. Bounded Levenshtein over the alias text -- catches typos and near-misses that FTS
 *      cannot see at all, because FTS tokens either match or they do not.
 *
 * Hints filter, but softly: if filtering empties the result the filter is dropped and the
 * fact is reported, because the keyword parser guesses and a guess must not be able to
 * hide the right answer.
 */

export interface ResolveOptions {
  featureTypeFilter?: string | null;
  jurisdictionFilter?: string | null;
  limit?: number;
  /** Pre-parsed query, e.g. from the Claude parser in M4. */
  parsed?: ParsedQuery;
}

export interface ResolveResult {
  candidates: Candidate[];
  parsed: ParsedQuery;
  timings: { parseMs: number; matchMs: number; rankMs: number };
  /** Non-fatal things the artist should know, e.g. that a hint was ignored. */
  notes: string[];
}

interface AliasRow {
  alias_id: number;
  feature_id: number;
  alias: string;
  alias_kind: AliasKind | null;
  official_name: string;
  feature_type: string;
  jurisdiction: string | null;
  source_id: number;
  source_name: string;
  source_jurisdiction: string | null;
  vintage: string | null;
  attribution: string | null;
  minx: number | null;
  miny: number | null;
  maxx: number | null;
  maxy: number | null;
  cached: number;
}

const FEATURE_JOIN = `
  FROM aliases a
  JOIN features f ON f.id = a.feature_id
  JOIN sources  s ON s.id = f.source_id
`;

const FEATURE_COLUMNS = `
  a.id            AS alias_id,
  a.feature_id    AS feature_id,
  a.alias         AS alias,
  a.alias_kind    AS alias_kind,
  f.official_name AS official_name,
  f.feature_type  AS feature_type,
  f.jurisdiction  AS jurisdiction,
  s.id            AS source_id,
  s.name          AS source_name,
  s.jurisdiction  AS source_jurisdiction,
  s.vintage       AS vintage,
  s.attribution   AS attribution,
  f.minx, f.miny, f.maxx, f.maxy,
  (SELECT COUNT(*) FROM geometries g WHERE g.feature_id = f.id) AS cached
`;

/**
 * Builds a safe FTS5 MATCH expression. User text goes straight into a MATCH clause and
 * FTS5 has its own operator syntax, so only word characters survive and every token is
 * quoted.
 */
export function toFtsQuery(input: string, mode: 'all' | 'any'): string | null {
  const tokens = normalizeText(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const quoted = tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`));
  return quoted.join(mode === 'all' ? ' AND ' : ' OR ');
}

/** The fuzzy index is expensive to build, so it is memoised until the aliases change. */
let cached: { index: FuzzyIndex; signature: string } | null = null;

function aliasSignature(db: Db): string {
  const row = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), 0) m FROM aliases').get() as { n: number; m: number };
  return `${row.n}:${row.m}`;
}

export function fuzzyIndexFor(db: Db): FuzzyIndex {
  const signature = aliasSignature(db);
  if (cached && cached.signature === signature) return cached.index;

  const rows = db.prepare('SELECT id, feature_id, alias FROM aliases').all() as {
    id: number;
    feature_id: number;
    alias: string;
  }[];

  const entries: FuzzyEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // The alias table holds both verbatim and normalised forms; one normalised copy per
    // feature is enough, which roughly halves the index.
    const text = normalizeText(r.alias);
    if (!text) continue;
    const key = `${r.feature_id}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ aliasId: r.id, featureId: r.feature_id, text });
  }

  const index = new FuzzyIndex(entries);
  cached = { index, signature };
  return index;
}

/** Discards the memoised index; call after a harvest changes the alias table. */
export function invalidateFuzzyIndex(): void {
  cached = null;
}

export function tokensOf(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Decides whether a loose (OR) match is substantive rather than incidental.
 *
 * The loose pass exists for one job: a request carrying words the official name does not
 * have, like "Six Nations of the Grand River" against "SIX NATIONS INDIAN RESERVE NO. 40".
 * Left ungated it also returns every alias sharing a single throwaway word, so a hit has
 * to earn its place: at least one substantial word matched, and more than one word unless
 * the whole query was a single word.
 *
 * Note what is NOT needed here. "Wasauksing First Nation" never reaches this pass on the
 * strength of "first nation", because the loose pass only ever runs on the parser's
 * most-stripped variant -- where the designation has already been removed and only
 * "wasauksing" remains.
 */
export function isSubstantiveLooseMatch(queryTokens: string[], aliasText: string): boolean {
  if (queryTokens.length === 0) return false;
  const aliasTokens = new Set(tokensOf(aliasText));
  const matched = [...new Set(queryTokens)].filter((t) => aliasTokens.has(t));

  // "of", "the", "no" carry no identifying information.
  if (!matched.some((t) => t.length >= 4)) return false;
  return matched.length >= 2 || queryTokens.length === 1;
}

interface Hit {
  row: AliasRow;
  nameScore: number;
  exact: boolean;
  via: 'fts-all' | 'fts-any' | 'fuzzy';
}

export function resolve(db: Db, prompt: string, opts: ResolveOptions = {}): ResolveResult {
  const notes: string[] = [];

  const t0 = Date.now();
  const parsed = opts.parsed ?? parsePrompt(prompt);
  const parseMs = Date.now() - t0;

  const t1 = Date.now();

  // Explicit UI filters beat anything the parser inferred.
  const typeFilter = opts.featureTypeFilter ?? parsed.featureTypeHint;
  const jurFilter = opts.jurisdictionFilter ?? parsed.jurisdictionHint;

  const byAlias = new Map<number, Hit>();
  const consider = (row: AliasRow, nameScore: number, exact: boolean, via: Hit['via']): void => {
    const existing = byAlias.get(row.alias_id);
    if (existing && existing.nameScore >= nameScore) return;
    byAlias.set(row.alias_id, { row, nameScore, exact, via });
  };

  const ftsAll = db.prepare(
    `WITH matched AS MATERIALIZED (
       SELECT features_fts.rowid AS alias_id, bm25(features_fts) AS score
       FROM features_fts WHERE features_fts MATCH ?
     )
     SELECT ${FEATURE_COLUMNS}, matched.score AS score
     FROM matched JOIN aliases a ON a.id = matched.alias_id
     JOIN features f ON f.id = a.feature_id
     JOIN sources  s ON s.id = f.source_id
     ORDER BY matched.score LIMIT 300`,
  );

  const normalizedNames = parsed.placeNames.map((n) => normalizeText(n)).filter(Boolean);

  for (const [i, name] of parsed.placeNames.entries()) {
    // Later variants are less specific, so their matches start from a lower name score.
    const variantPenalty = i === 0 ? 0 : Math.min(0.15, 0.05 * i);
    const queryTokens = tokensOf(name);

    // The loose pass only ever runs on the most-stripped variant. On a later variant it
    // would match the designation words the stripping exists to remove -- turning
    // "Wasauksing First Nation" into every First Nation in Canada.
    const modes = i === 0 ? (['all', 'any'] as const) : (['all'] as const);

    for (const mode of modes) {
      const match = toFtsQuery(name, mode);
      if (!match) continue;
      const rows = ftsAll.all(match) as (AliasRow & { score: number })[];
      if (rows.length === 0) continue;

      let kept = 0;
      for (const row of rows) {
        const aliasNorm = normalizeText(row.alias);
        // The loose pass matches on any single token, so most of what it returns is
        // noise. Keep only hits that account for the distinctive part of the query.
        if (mode === 'any' && !isSubstantiveLooseMatch(queryTokens, aliasNorm)) continue;
        kept++;

        const exact = normalizedNames.includes(aliasNorm);
        // FTS rank is relative to the result set, so derive a stable 0..1 from how much
        // of the alias the query actually accounted for.
        const coverage = aliasNorm.length === 0 ? 0 : Math.min(1, normalizeText(name).length / aliasNorm.length);
        const base = exact ? 1 : (mode === 'all' ? 0.82 : 0.6) * (0.6 + 0.4 * coverage);
        consider(row, Math.max(0, base - variantPenalty), exact, mode === 'all' ? 'fts-all' : 'fts-any');
      }

      // A precise pass that found something is enough for this variant; the loose pass
      // only exists to rescue a variant the precise pass missed entirely.
      if (mode === 'all' && kept > 0) break;
    }
  }

  // Fuzzy pass, on the most specific variant only -- running it on every variant would
  // mostly re-find the same features at lower confidence.
  const fuzzyQuery = normalizedNames[0];
  if (fuzzyQuery && fuzzyQuery.length >= 3) {
    const index = fuzzyIndexFor(db);
    const hits = index.search(fuzzyQuery, { limit: 60 });
    if (hits.length > 0) {
      const lookup = db.prepare(
        `SELECT ${FEATURE_COLUMNS} ${FEATURE_JOIN} WHERE a.id IN (${hits.map(() => '?').join(',')})`,
      );
      const rows = lookup.all(...hits.map((h) => h.aliasId)) as AliasRow[];
      const scoreByAlias = new Map(hits.map((h) => [h.aliasId, h.score]));
      for (const row of rows) {
        const score = scoreByAlias.get(row.alias_id) ?? 0;
        consider(row, score * 0.95, score === 1, 'fuzzy');
      }
    }
  }

  const matchMs = Date.now() - t1;
  const t2 = Date.now();

  // Collapse alias hits down to one per feature, keeping the best-scoring alias.
  const byFeature = new Map<number, Hit>();
  for (const hit of byAlias.values()) {
    const existing = byFeature.get(hit.row.feature_id);
    if (!existing || hit.nameScore > existing.nameScore) byFeature.set(hit.row.feature_id, hit);
  }

  let hits = [...byFeature.values()];

  /*
   * When the query matched something exactly, weak fuzzy hits are just noise.
   * "Parry Island First Nation" is two edits from "Avery Island" and "Bare Island", and
   * without this the top five is three-fifths wrong islands. If the artist typed the name
   * correctly, near-misses have nothing to offer; if they mistyped it, no exact match
   * exists and the fuzzy pass still carries the whole result.
   */
  const hasExact = hits.some((h) => h.exact);
  if (hasExact) {
    hits = hits.filter((h) => h.via !== 'fuzzy' || h.nameScore >= 0.9);
  }

  // Soft filtering: drop the filter rather than return nothing.
  const applyFilter = (list: Hit[], label: string, predicate: (h: Hit) => boolean): Hit[] => {
    const filtered = list.filter(predicate);
    if (filtered.length > 0) return filtered;
    if (list.length > 0) notes.push(`no result matched the ${label} filter, so it was ignored`);
    return list;
  };

  if (typeFilter) hits = applyFilter(hits, 'type', (h) => h.row.feature_type === typeFilter);
  if (jurFilter) hits = applyFilter(hits, 'jurisdiction', (h) => h.row.jurisdiction === jurFilter);

  const scored = hits.map((h) => {
    const source = {
      jurisdiction: h.row.source_jurisdiction,
      attribution: h.row.attribution,
      vintage: h.row.vintage,
    };
    const featureType = h.row.feature_type as FeatureType;
    const breakdown = scoreCandidate({
      featureType,
      jurisdiction: h.row.jurisdiction,
      source,
      aliasKind: h.row.alias_kind,
      nameScore: h.nameScore,
      exact: h.exact,
      featureTypeHint: (typeFilter as FeatureType | null) ?? null,
      jurisdictionHint: jurFilter ?? null,
      vintageHint: parsed.vintageHint,
    });
    return { hit: h, breakdown, featureType, source };
  });

  scored.sort((a, b) => b.breakdown.total - a.breakdown.total || a.hit.row.official_name.localeCompare(b.hit.row.official_name));

  const limit = opts.limit ?? 15;
  const candidates: Candidate[] = scored.slice(0, limit).map(({ hit, breakdown, featureType, source }) => ({
    featureId: hit.row.feature_id,
    officialName: hit.row.official_name,
    featureType,
    jurisdiction: hit.row.jurisdiction,
    sourceId: hit.row.source_id,
    sourceName: hit.row.source_name,
    vintage: hit.row.vintage,
    attribution: hit.row.attribution,
    bbox:
      hit.row.minx !== null && hit.row.miny !== null && hit.row.maxx !== null && hit.row.maxy !== null
        ? [hit.row.minx, hit.row.miny, hit.row.maxx, hit.row.maxy]
        : null,
    hasCachedGeometry: hit.row.cached > 0,
    matchScore: breakdown.total,
    matchedAlias: hit.row.alias,
    matchedVia: hit.via,
    justification: explain(featureType, source, breakdown),
  }));

  return { candidates, parsed, timings: { parseMs, matchMs, rankMs: Date.now() - t2 }, notes };
}
