import type { AliasKind } from '@shared/types';

/**
 * Alias generation.
 *
 * The brief calls this make-or-break, and the live data agrees. The test query is
 * "Parry Island First Nation"; the federal record is filed as "PARRY ISLAND FIRST NATION"
 * in caps, Ontario files the same place in title case, and a riding like
 * "Parry Sound—Muskoka" separates its parts with an em dash that nobody types.
 *
 * So every name field produces two things: the value verbatim, and a normalised
 * "stripped" form used for matching. Normalising both the stored alias and the incoming
 * query means the two meet in the middle.
 */

export interface AliasCandidate {
  alias: string;
  kind: AliasKind;
}

/** Dash characters that all have to become a plain hyphen before matching. */
const DASHES = /[‐‑‒–—―−]/g;
/** Curly quotes and primes that have to become a plain apostrophe. */
const APOSTROPHES = /[‘’ʼ′´`]/g;

/**
 * Lowercase, strip diacritics, normalise dashes and apostrophes, collapse whitespace.
 * Deliberately keeps hyphens and apostrophes: "Taiaiako'n—Parkdale—High Park" and
 * "Saint-Jean" lose their identity without them.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(DASHES, '-')
    // StatCan writes ridings as "Parry Sound--Muskoka" while Elections Canada and Ontario
    // use a real em dash. Collapsing runs of hyphens makes the two forms identical.
    .replace(/-{2,}/g, '-')
    .replace(APOSTROPHES, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Leading administrative qualifiers, longest first so the greedy match wins. */
const LEADING_QUALIFIERS = [
  'regional municipality of',
  'united counties of',
  'municipality of',
  'corporation of',
  'township of',
  'district of',
  'village of',
  'county of',
  'town of',
  'city of',
  'the',
];

/** Trailing designations that a person typing a place name usually omits. */
const TRAILING_DESIGNATIONS = [
  'first nations',
  'first nation',
  'indian reserve',
  'indian settlement',
  'settlement lands',
  'settlement land',
  'national park reserve',
  'national park',
  'provincial park',
  'reserve',
  'nation',
  'band',
  'i.r.',
  'ir',
];

/**
 * Reserve numbering: "Shoal Lake 39A", "Indian Reserve No. 16", "... IR 16".
 * Captured so the bare number can be searched on its own.
 */
const RESERVE_NUMBER = /\b(?:no\.?\s*|number\s*|ir\s*|#\s*)?(\d+[a-z]?)\s*$/i;

function stripLeading(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const q of LEADING_QUALIFIERS) {
      if (out.startsWith(`${q} `)) {
        out = out.slice(q.length + 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function stripTrailingOnce(text: string): string | null {
  for (const d of TRAILING_DESIGNATIONS) {
    if (text.endsWith(` ${d}`)) return text.slice(0, text.length - d.length - 1).trim();
  }
  const numbered = RESERVE_NUMBER.exec(text);
  if (numbered && numbered.index > 0) {
    const withoutNumber = text.slice(0, numbered.index).trim();
    if (withoutNumber.length >= 3) return withoutNumber;
  }
  return null;
}

/**
 * Peels trailing designations and reserve numbers alternately until nothing more comes
 * off. "Shoal Lake Indian Reserve No. 39A" has to lose the number before "indian reserve"
 * is even at the end of the string, so one pass of each is not enough.
 */
function stripTrailing(text: string, collect?: (v: string) => void): string {
  let out = text;
  for (;;) {
    const next = stripTrailingOnce(out);
    if (next === null || next === out || next.length < 2) return out;
    out = next;
    collect?.(out);
  }
}

/**
 * Every searchable form of one raw name. Always includes the plain normalised text;
 * adds progressively stripped variants only when they differ and stay meaningful.
 */
export function strippedVariants(rawName: string): string[] {
  const out = new Set<string>();
  const base = normalizeText(rawName);
  if (!base) return [];
  out.add(base);

  const noQualifier = stripLeading(base);
  if (noQualifier) out.add(noQualifier);

  // Every intermediate form is searchable, not just the fully stripped one.
  stripTrailing(noQualifier, (v) => out.add(v));

  // "Parry Sound-Muskoka" should also be findable as "Parry Sound Muskoka".
  for (const v of [...out]) {
    if (v.includes('-')) {
      const spaced = v.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      if (spaced) out.add(spaced);
    }
  }

  // Guard against stripping a name down to nothing useful.
  return [...out].filter((v) => v.length >= 2);
}

export interface NameFieldValue {
  field: string;
  value: string;
  kind: AliasKind;
}

/**
 * Builds the full alias set for one feature: every raw name value verbatim, plus every
 * stripped variant of each. De-duplicated, because `aliases` is UNIQUE per feature and a
 * source that repeats a name across fields is normal, not an error.
 */
export function buildAliases(officialName: string, values: NameFieldValue[]): AliasCandidate[] {
  const seen = new Map<string, AliasKind>();

  const add = (alias: string, kind: AliasKind): void => {
    const trimmed = alias.trim();
    if (trimmed.length < 2) return;
    // 'official' and 'french' outrank 'attribute', which outranks 'stripped'.
    const existing = seen.get(trimmed);
    if (existing && rank(existing) <= rank(kind)) return;
    seen.set(trimmed, kind);
  };

  add(officialName, 'official');
  for (const v of strippedVariants(officialName)) add(v, 'stripped');

  for (const { value, kind } of values) {
    if (!value) continue;
    add(value, kind);
    for (const v of strippedVariants(value)) add(v, 'stripped');
  }

  return [...seen.entries()].map(([alias, kind]) => ({ alias, kind }));
}

function rank(kind: AliasKind): number {
  switch (kind) {
    case 'official':
      return 0;
    case 'french':
      return 1;
    case 'manual':
      return 2;
    case 'attribute':
      return 3;
    case 'stripped':
      return 4;
  }
}

/** French name fields, so aliases get tagged correctly rather than all as 'attribute'. */
export function kindForField(field: string): AliasKind {
  if (/(?:^|_)(?:fr|fra|french|nom)(?:$|_)|NAMEF$|_FR$|Fra$/i.test(field)) return 'french';
  return 'attribute';
}
