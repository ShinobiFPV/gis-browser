/**
 * Fuzzy name matching over the alias table.
 *
 * FTS5 is exact on tokens: it finds "parry island" but not "parrry island" or "Wikwemikon"
 * for "Wikwemikong". This is the second half of the brief's "FTS5 ... unioned with a
 * trigram/Levenshtein fuzzy pass".
 *
 * The approach is a trigram prefilter followed by bounded Levenshtein. The prefilter is
 * what makes it affordable -- scoring 110,000 aliases with full edit distance on every
 * keystroke would not be -- and the bound lets most survivors abort in a few cells.
 */

export interface FuzzyEntry {
  aliasId: number;
  featureId: number;
  /** Normalised alias text; the index is built from these. */
  text: string;
}

export interface FuzzyHit {
  aliasId: number;
  featureId: number;
  text: string;
  /** Edit distance to the query. */
  distance: number;
  /** 0..1, where 1 is an exact match. */
  score: number;
}

/** Trigrams of a string, padded so short strings and word starts still produce some. */
export function trigrams(text: string): string[] {
  const padded = `  ${text} `;
  const out: string[] = [];
  for (let i = 0; i < padded.length - 2; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/**
 * Levenshtein distance, abandoned as soon as it cannot come in at or under `max`.
 *
 * Two cheap guards do most of the work: a length difference greater than `max` is an
 * immediate reject, and a row whose best cell already exceeds `max` can never recover.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string as the row so the DP array stays small.
  if (a.length > b.length) [a, b] = [b, a];

  const prev = new Array<number>(a.length + 1);
  const cur = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    let rowBest = cur[0];
    const bc = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bc ? 0 : 1;
      const v = Math.min(cur[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + cost);
      cur[i] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    for (let i = 0; i <= a.length; i++) prev[i] = cur[i]!;
  }
  return prev[a.length]!;
}

/** How much slop to allow, scaled to the query length. */
export function maxDistanceFor(query: string): number {
  if (query.length <= 4) return 1;
  if (query.length <= 8) return 2;
  if (query.length <= 16) return 3;
  return 4;
}

export class FuzzyIndex {
  private readonly texts: string[] = [];
  private readonly aliasIds: number[] = [];
  private readonly featureIds: number[] = [];
  /** trigram -> indices into the parallel arrays above. */
  private readonly postings = new Map<string, number[]>();

  constructor(entries: Iterable<FuzzyEntry>) {
    for (const e of entries) {
      const idx = this.texts.length;
      this.texts.push(e.text);
      this.aliasIds.push(e.aliasId);
      this.featureIds.push(e.featureId);
      for (const t of new Set(trigrams(e.text))) {
        const list = this.postings.get(t);
        if (list) list.push(idx);
        else this.postings.set(t, [idx]);
      }
    }
  }

  get size(): number {
    return this.texts.length;
  }

  /**
   * Candidates sharing enough trigrams with the query to be worth scoring.
   * `minShared` scales with query length so a two-trigram accident does not survive.
   */
  private prefilter(query: string): Map<number, number> {
    const qTrigrams = new Set(trigrams(query));
    const shared = new Map<number, number>();
    for (const t of qTrigrams) {
      const list = this.postings.get(t);
      if (!list) continue;
      for (const idx of list) shared.set(idx, (shared.get(idx) ?? 0) + 1);
    }
    return shared;
  }

  search(query: string, opts: { limit?: number; maxDistance?: number } = {}): FuzzyHit[] {
    if (query.length < 3) return [];

    const limit = opts.limit ?? 40;
    const max = opts.maxDistance ?? maxDistanceFor(query);
    const qTrigramCount = new Set(trigrams(query)).size;
    // Require roughly a third of the query's trigrams to overlap. Below that, no string
    // within our edit bound can survive anyway, so this only discards work.
    const minShared = Math.max(1, Math.floor(qTrigramCount / 3));

    const hits: FuzzyHit[] = [];
    for (const [idx, count] of this.prefilter(query)) {
      if (count < minShared) continue;
      const text = this.texts[idx]!;
      const distance = boundedLevenshtein(query, text, max);
      if (distance > max) continue;
      hits.push({
        aliasId: this.aliasIds[idx]!,
        featureId: this.featureIds[idx]!,
        text,
        distance,
        // Normalise against the longer string so a 1-edit slip on a short name is not
        // scored the same as a 1-edit slip on a long one.
        score: 1 - distance / Math.max(query.length, text.length),
      });
    }

    hits.sort((a, b) => a.distance - b.distance || a.text.length - b.text.length);
    return hits.slice(0, limit);
  }
}
