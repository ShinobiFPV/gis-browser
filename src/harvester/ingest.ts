import type { Db } from '@db/index';
import type { FeatureType, Jurisdiction } from '@shared/taxonomy';
import { isJurisdiction } from '@shared/taxonomy';
import type { SourceRow } from '@shared/types';
import { buildAliases, kindForField, type NameFieldValue } from './normalize/aliases';
import { refineFeatureType } from './normalize/feature-type';
import { unionBbox, withinCanada, type Bbox } from './normalize/crs';
import type { IndexedRow } from './catalogs/esri-rest';

/** StatCan province/territory identifiers, used to derive per-row jurisdiction. */
const PRUID: Record<string, Jurisdiction> = {
  '10': 'NL',
  '11': 'PE',
  '12': 'NS',
  '13': 'NB',
  '24': 'QC',
  '35': 'ON',
  '46': 'MB',
  '47': 'SK',
  '48': 'AB',
  '59': 'BC',
  '60': 'YT',
  '61': 'NT',
  '62': 'NU',
};

const PROVINCE_NAMES: Record<string, Jurisdiction> = {
  alberta: 'AB',
  'british columbia': 'BC',
  manitoba: 'MB',
  'new brunswick': 'NB',
  'newfoundland and labrador': 'NL',
  'nova scotia': 'NS',
  'northwest territories': 'NT',
  nunavut: 'NU',
  ontario: 'ON',
  'prince edward island': 'PE',
  quebec: 'QC',
  québec: 'QC',
  saskatchewan: 'SK',
  yukon: 'YT',
};

function deriveJurisdiction(attrs: Record<string, unknown>, fallback: string | null): string | null {
  const pruid = attrs['PRUID'];
  if (typeof pruid === 'string' || typeof pruid === 'number') {
    const mapped = PRUID[String(pruid).trim()];
    if (mapped) return mapped;
  }
  const jur = attrs['jurisdictionEng'];
  if (typeof jur === 'string') {
    const mapped = PROVINCE_NAMES[jur.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return fallback && isJurisdiction(fallback) ? fallback : fallback;
}

function pickOfficialName(attrs: Record<string, unknown>, nameFields: string[]): string | null {
  for (const field of nameFields) {
    const v = attrs[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function collectNameValues(attrs: Record<string, unknown>, nameFields: string[]): NameFieldValue[] {
  const out: NameFieldValue[] = [];
  for (const field of nameFields) {
    const v = attrs[field];
    if (typeof v === 'string' && v.trim()) out.push({ field, value: v.trim(), kind: kindForField(field) });
    else if (typeof v === 'number' && Number.isFinite(v)) out.push({ field, value: String(v), kind: 'attribute' });
  }
  return out;
}

export interface IngestStats {
  rowsSeen: number;
  featuresWritten: number;
  featuresMerged: number;
  aliasesWritten: number;
  bboxRejected: number;
}

export function emptyStats(): IngestStats {
  return { rowsSeen: 0, featuresWritten: 0, featuresMerged: 0, aliasesWritten: 0, bboxRejected: 0 };
}

export interface Ingestor {
  writeBatch(rows: IndexedRow[]): void;
  readonly stats: IngestStats;
}

/**
 * Writes an indexed page into the catalog.
 *
 * Everything for one page happens in a single transaction, so an interrupted harvest
 * leaves whole pages behind and the checkpoint offset stays truthful.
 *
 * `identity_field` handles multipart layers: Elections Canada's 2025 layer publishes 352
 * rows for 343 ridings, one row per polygon. Keying on FED_NUM instead of OBJECTID merges
 * them into one feature whose bbox is the union of its parts, which is what an artist
 * asking for "Nunavut" actually wants.
 */
export function createIngestor(db: Db, source: SourceRow): Ingestor {
  const nameFields: string[] = source.name_fields ? (JSON.parse(source.name_fields) as string[]) : [];
  const identityField = source.identity_field;
  const stats = emptyStats();

  const selectExisting = db.prepare(
    'SELECT id, minx, miny, maxx, maxy FROM features WHERE source_id = ? AND source_feature_id = ?',
  );

  const insertFeature = db.prepare(`
    INSERT INTO features (
      source_id, source_feature_id, official_name, feature_type, jurisdiction,
      attributes_json, minx, miny, maxx, maxy, retrieved_at
    ) VALUES (
      @source_id, @source_feature_id, @official_name, @feature_type, @jurisdiction,
      @attributes_json, @minx, @miny, @maxx, @maxy, @retrieved_at
    )
    ON CONFLICT(source_id, source_feature_id) DO UPDATE SET
      official_name  = excluded.official_name,
      feature_type   = excluded.feature_type,
      jurisdiction   = excluded.jurisdiction,
      attributes_json= excluded.attributes_json,
      minx = excluded.minx, miny = excluded.miny,
      maxx = excluded.maxx, maxy = excluded.maxy,
      retrieved_at   = excluded.retrieved_at
  `);

  const upsertRtree = db.prepare(
    'INSERT OR REPLACE INTO features_rtree (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteAliases = db.prepare('DELETE FROM aliases WHERE feature_id = ?');
  const insertAlias = db.prepare(
    'INSERT INTO aliases (feature_id, alias, alias_kind) VALUES (?, ?, ?) ON CONFLICT(feature_id, alias) DO NOTHING',
  );

  const writeOne = (row: IndexedRow): void => {
    stats.rowsSeen++;

    const attrs = row.attributes;
    const featureId = identityField ? attrs[identityField] : undefined;
    if (identityField && (featureId === undefined || featureId === null)) {
      throw new Error(
        `Source "${source.name}" declares identity_field "${identityField}" but a row does not carry it. ` +
          `Merging would silently drop features.`,
      );
    }
    const key = identityField ? String(featureId) : row.sourceFeatureId;

    const officialName = pickOfficialName(attrs, nameFields);
    if (!officialName) {
      throw new Error(
        `Row ${key} of "${source.name}" has no value in any declared name field [${nameFields.join(', ')}]. ` +
          `A nameless feature cannot be searched for.`,
      );
    }

    // Reject nonsense geometry rather than poisoning the R-tree with it.
    let bbox: Bbox | null = row.bbox;
    if (bbox) {
      const check = withinCanada(bbox);
      if (!check.ok) {
        stats.bboxRejected++;
        console.warn(`[ingest] ${source.name} ${key}: bbox rejected -- ${check.reason}`);
        bbox = null;
      }
    }

    const existing = selectExisting.get(source.id, key) as
      | { id: number; minx: number | null; miny: number | null; maxx: number | null; maxy: number | null }
      | undefined;

    if (existing && identityField) {
      stats.featuresMerged++;
      const prior: Bbox | null =
        existing.minx !== null && existing.miny !== null && existing.maxx !== null && existing.maxy !== null
          ? { minx: existing.minx, miny: existing.miny, maxx: existing.maxx, maxy: existing.maxy }
          : null;
      bbox = unionBbox(prior, bbox);
    }

    const featureType: FeatureType = refineFeatureType({
      declaredType: source.feature_type,
      endpoint: source.endpoint,
      attributes: attrs,
    });

    insertFeature.run({
      source_id: source.id,
      source_feature_id: key,
      official_name: officialName,
      feature_type: featureType,
      jurisdiction: deriveJurisdiction(attrs, source.jurisdiction),
      attributes_json: JSON.stringify(attrs),
      minx: bbox?.minx ?? null,
      miny: bbox?.miny ?? null,
      maxx: bbox?.maxx ?? null,
      maxy: bbox?.maxy ?? null,
      retrieved_at: new Date().toISOString(),
    });

    const rowId = (existing?.id ?? (selectExisting.get(source.id, key) as { id: number }).id);
    if (!existing) stats.featuresWritten++;

    if (bbox) upsertRtree.run(rowId, bbox.minx, bbox.maxx, bbox.miny, bbox.maxy);

    // Aliases are rebuilt rather than appended, so a re-harvest cannot accumulate stale
    // names from a previous vintage of the same feature.
    deleteAliases.run(rowId);
    for (const a of buildAliases(officialName, collectNameValues(attrs, nameFields))) {
      const info = insertAlias.run(rowId, a.alias, a.kind);
      stats.aliasesWritten += info.changes;
    }
  };

  const writeBatch = db.transaction((rows: IndexedRow[]) => {
    for (const r of rows) writeOne(r);
  });

  return { writeBatch, stats };
}
