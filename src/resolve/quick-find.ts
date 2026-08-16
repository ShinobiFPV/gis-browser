import type { Db } from '@db/index';
import type { Candidate } from '@shared/types';
import type { FeatureType } from '@shared/taxonomy';

/**
 * PROVISIONAL name lookup.
 *
 * This is not the resolve layer. It is a straight FTS5 lookup over `aliases` with no
 * fuzzy pass, no ranking model and no LLM, and it exists so M2 has a way to select a
 * feature and put a real boundary on the map. M3 replaces the body of this module with
 * the actual matcher (FTS ∪ trigram/Levenshtein, type and jurisdiction filters, ranking)
 * behind the same signature.
 */

/**
 * Turns free text into a safe FTS5 MATCH expression.
 *
 * User input goes straight into a MATCH clause, and FTS5 has its own operator syntax --
 * a stray quote or a bare `AND` would either error or silently change the query. So we
 * keep only word characters, quote every token, and combine them ourselves.
 */
export function toFtsQuery(input: string, { prefix = true }: { prefix?: boolean } = {}): string | null {
  const tokens = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  return tokens
    .map((t, i) => {
      const quoted = `"${t}"`;
      // Prefix-match only the final token, so typing "parry isl" still finds the reserve
      // while "parry" does not silently match "parryville".
      return prefix && i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

export interface QuickFindOptions {
  featureType?: string | null;
  jurisdiction?: string | null;
  limit?: number;
}

interface Row {
  feature_id: number;
  official_name: string;
  feature_type: string;
  jurisdiction: string | null;
  source_id: number;
  source_name: string;
  vintage: string | null;
  attribution: string | null;
  minx: number | null;
  miny: number | null;
  maxx: number | null;
  maxy: number | null;
  cached: number;
  alias: string;
  score: number;
}

export function quickFind(db: Db, text: string, opts: QuickFindOptions = {}): Candidate[] {
  const match = toFtsQuery(text);
  if (!match) return [];

  const limit = opts.limit ?? 15;

  // bm25() is only callable where the FTS table is the direct query target, so scoring
  // happens in a CTE and the grouping joins against it.
  //
  // Group by feature so one matching through five aliases appears once. bm25 is negative
  // and lower is better, hence MIN(); SQLite's bare-column rule then makes `a.alias` come
  // from the row that produced that minimum, i.e. the alias that actually matched best.
  const rows = db
    .prepare(
      // MATERIALIZED is load-bearing: without it SQLite flattens the CTE into the outer
      // join and bm25() lands back in a context it cannot be called from.
      `WITH matched AS MATERIALIZED (
         SELECT features_fts.rowid AS alias_id, bm25(features_fts) AS score
         FROM features_fts
         WHERE features_fts MATCH ?
       )
       SELECT
         f.id            AS feature_id,
         f.official_name AS official_name,
         f.feature_type  AS feature_type,
         f.jurisdiction  AS jurisdiction,
         s.id            AS source_id,
         s.name          AS source_name,
         s.vintage       AS vintage,
         s.attribution   AS attribution,
         f.minx, f.miny, f.maxx, f.maxy,
         (SELECT COUNT(*) FROM geometries g WHERE g.feature_id = f.id) AS cached,
         a.alias         AS alias,
         MIN(matched.score) AS score
       FROM matched
       JOIN aliases  a ON a.id = matched.alias_id
       JOIN features f ON f.id = a.feature_id
       JOIN sources  s ON s.id = f.source_id
       WHERE (? IS NULL OR f.feature_type = ?)
         AND (? IS NULL OR f.jurisdiction = ?)
       GROUP BY f.id
       ORDER BY score
       LIMIT ?`,
    )
    .all(
      match,
      opts.featureType ?? null,
      opts.featureType ?? null,
      opts.jurisdiction ?? null,
      opts.jurisdiction ?? null,
      limit,
    ) as Row[];

  if (rows.length === 0) return [];

  // bm25 scores are unbounded negatives; map them onto 0..1 so the UI has something
  // meaningful to show. This is display normalisation, NOT the confidence model -- that
  // arrives with the ranker in M4.
  const best = rows[0]!.score;
  const worst = rows[rows.length - 1]!.score;
  const span = worst - best || 1;

  return rows.map((r) => ({
    featureId: r.feature_id,
    officialName: r.official_name,
    featureType: r.feature_type as FeatureType,
    jurisdiction: r.jurisdiction,
    sourceId: r.source_id,
    sourceName: r.source_name,
    vintage: r.vintage,
    attribution: r.attribution,
    bbox:
      r.minx !== null && r.miny !== null && r.maxx !== null && r.maxy !== null
        ? [r.minx, r.miny, r.maxx, r.maxy]
        : null,
    hasCachedGeometry: r.cached > 0,
    matchScore: Number((1 - (r.score - best) / span).toFixed(3)),
    matchedAlias: r.alias,
  }));
}
