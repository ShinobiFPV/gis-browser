import type { Db } from '@db/index';
import { normalizeText } from '../harvester/normalize/aliases';

/**
 * Curated aliases for names that appear in NO official source.
 *
 * The brief's own test case is the reason this exists. "Parry Island First Nation" is
 * filed under exactly that name federally and in Ontario, but the community's own name --
 * Wasauksing -- appears nowhere in any harvested layer. Someone who types the name the
 * community uses would get nothing.
 *
 * SCOPE, deliberately narrow. Every entry below was checked against the harvested catalog:
 * the alias genuinely returns no results, and the target name genuinely exists. Nothing
 * here is inferred. Where a name is already carried by a source -- Ontario's LIO
 * OTHER_NAME field supplies plenty of band names, and the census subdivision layer often
 * uses community names -- no entry is needed and none was added.
 *
 * These are aliases, not corrections: they add a way to FIND a feature, and never change
 * its official name, its geometry or its attribution. An alias may legitimately point at
 * several features (a community spanning two reserves), because the UI always presents
 * candidates and never auto-exports.
 *
 * This list should grow from newsroom use. Adding an entry is safe; getting one wrong
 * surfaces as an extra candidate to reject, not as a silently wrong boundary.
 */

export interface ManualAlias {
  /** Names to add. Matched case- and accent-insensitively. */
  aliases: string[];
  /** Official name of the target feature, as it appears in `features.official_name`. */
  targetOfficialName: string;
  /** Restricts the match; omit to apply to every feature with that official name. */
  featureType?: string;
  jurisdiction?: string;
  /** Why this entry exists. Kept in the source so it can be audited later. */
  note: string;
}

export const MANUAL_ALIASES: ManualAlias[] = [
  {
    aliases: ['Wasauksing', 'Wasauksing First Nation'],
    targetOfficialName: 'Parry Island First Nation',
    featureType: 'indian_reserve',
    note: 'The community on Parry Island is Wasauksing First Nation. The name appears in no harvested source.',
  },
  {
    aliases: ['Bkejwanong', 'Bkejwanong First Nation'],
    targetOfficialName: 'Walpole Island 46',
    featureType: 'indian_reserve',
    note: 'Bkejwanong is the Anishinaabe name for Walpole Island. Absent from every harvested source.',
  },
  {
    aliases: ['Aamjiwnaang', 'Aamjiwnaang First Nation'],
    targetOfficialName: 'Sarnia 45',
    featureType: 'indian_reserve',
    note: 'Aamjiwnaang First Nation is the community on the reserve filed as Sarnia 45. Absent from every source.',
  },
  {
    aliases: ['St. Regis', 'Saint Regis'],
    targetOfficialName: 'Akwesasne 59',
    featureType: 'indian_reserve',
    note: 'St. Regis is the historical name for Akwesasne; an older script or wire copy may still use it.',
  },
];

export interface ManualAliasResult {
  inserted: number;
  unmatched: { alias: string; target: string }[];
}

/**
 * Applies the curated aliases to the catalog.
 *
 * Must run AFTER a harvest: ingest rebuilds a feature's aliases from scratch so a
 * re-harvest would otherwise drop these. Idempotent, so running it on every startup and
 * after every harvest costs nothing.
 *
 * An entry whose target is not in the catalog is reported rather than ignored -- it means
 * either the source renamed the feature or the entry was wrong, and both are worth seeing.
 */
export function applyManualAliases(db: Db, entries: ManualAlias[] = MANUAL_ALIASES): ManualAliasResult {
  const findFeatures = db.prepare(
    `SELECT id FROM features
     WHERE official_name = ? COLLATE NOCASE
       AND (? IS NULL OR feature_type = ?)
       AND (? IS NULL OR jurisdiction = ?)`,
  );
  const insertAlias = db.prepare(
    `INSERT INTO aliases (feature_id, alias, alias_kind) VALUES (?, ?, 'manual')
     ON CONFLICT(feature_id, alias) DO NOTHING`,
  );

  const result: ManualAliasResult = { inserted: 0, unmatched: [] };

  const run = db.transaction(() => {
    for (const entry of entries) {
      const rows = findFeatures.all(
        entry.targetOfficialName,
        entry.featureType ?? null,
        entry.featureType ?? null,
        entry.jurisdiction ?? null,
        entry.jurisdiction ?? null,
      ) as { id: number }[];

      if (rows.length === 0) {
        for (const alias of entry.aliases) {
          result.unmatched.push({ alias, target: entry.targetOfficialName });
        }
        continue;
      }

      for (const { id } of rows) {
        for (const alias of entry.aliases) {
          // Both the verbatim form and the normalised one, matching how ingest stores
          // every other alias, so FTS and the fuzzy index both see it.
          result.inserted += insertAlias.run(id, alias).changes;
          const normalized = normalizeText(alias);
          if (normalized && normalized !== alias) {
            result.inserted += insertAlias.run(id, normalized).changes;
          }
        }
      }
    }
  });

  run();
  return result;
}
