import type { Db } from '@db/index';
import type { FeatureType, Jurisdiction } from '@shared/taxonomy';
import { isJurisdiction } from '@shared/taxonomy';
import type { SourceRow } from '@shared/types';
import { buildAliases, kindForField, type NameFieldValue } from './normalize/aliases';
import { refineFeatureType } from './normalize/feature-type';
import {
  countVertices,
  intersectsCanada,
  unionBbox,
  withinCanada,
  type Bbox,
  type Geometry,
} from './normalize/crs';
import { mergeGeometries } from './geometry';
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
  /** Tier B only: geometries cached at index time rather than fetched lazily. */
  geometriesWritten: number;
  /** Rows with no value in any declared name field, skipped rather than indexed. */
  skippedNameless: number;
}

export interface IngestOptions {
  /**
   * What to do with a row that has no name.
   *
   * Tier A services publish boundaries, and a nameless row there means the registry's
   * name_fields are wrong -- worth failing the whole harvest over, because the alternative
   * is an index that silently omits ridings.
   *
   * Tier B world datasets are different. Natural Earth's 1,300 lakes include plenty of
   * genuinely unnamed ones; that is the data being accurate, not broken. They are skipped
   * and counted, since a nameless feature cannot be searched for by name and indexing it
   * would add a row nobody can ever reach. The caller checks the count: if EVERY row was
   * nameless, the name_fields really are wrong and that does fail.
   */
  namelessRows?: 'throw' | 'skip';

  /**
   * How strictly a feature's bbox must sit inside Canada.
   *
   * 'within' is right for Tier A: those services publish Canadian boundaries, so a bbox
   * outside the envelope means an unhandled CRS or a WFS axis flip, and nulling it keeps
   * the R-tree clean.
   *
   * 'intersects' is right for Tier B global archives. The United States in Natural Earth's
   * countries layer reaches Hawaii and American Samoa; it is a legitimate context feature
   * that borders Canada, and demanding containment would null its bbox and make it
   * invisible to every spatial query. Tier B gets a stronger CRS check anyway -- if the
   * whole layer reprojects outside Canada, run-bulk fails the harvest outright.
   */
  bboxPolicy?: 'within' | 'intersects';
}

export function emptyStats(): IngestStats {
  return {
    rowsSeen: 0,
    featuresWritten: 0,
    featuresMerged: 0,
    aliasesWritten: 0,
    bboxRejected: 0,
    geometriesWritten: 0,
    skippedNameless: 0,
  };
}

/**
 * A row that arrived with its geometry.
 *
 * Tier A indexes attributes and fetches geometry lazily on export, because a FeatureServer
 * can be asked for one boundary at a time. Tier B has no such option -- the geometry is
 * already in the file we downloaded -- so it is cached at index time and those features
 * are exportable offline from the moment the harvest finishes.
 */
export interface RowWithGeometry extends IndexedRow {
  geometry: unknown;
  vertexCount: number;
}

function hasGeometry(row: IndexedRow): row is RowWithGeometry {
  return 'geometry' in row && (row as RowWithGeometry).geometry != null;
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
export function createIngestor(db: Db, source: SourceRow, options: IngestOptions = {}): Ingestor {
  const nameFields: string[] = source.name_fields ? (JSON.parse(source.name_fields) as string[]) : [];
  const identityField = source.identity_field;
  const namelessRows = options.namelessRows ?? 'throw';
  const bboxPolicy = options.bboxPolicy ?? 'within';
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
  const upsertGeometry = db.prepare(`
    INSERT INTO geometries
      (feature_id, geometry_json, vertex_count, source_srid, content_hash, cached_at, generalisation_deg)
    VALUES
      (@feature_id, @geometry_json, @vertex_count, @source_srid, @content_hash, @cached_at, @generalisation_deg)
    ON CONFLICT(feature_id) DO UPDATE SET
      geometry_json      = excluded.geometry_json,
      vertex_count       = excluded.vertex_count,
      source_srid        = excluded.source_srid,
      content_hash       = excluded.content_hash,
      cached_at          = excluded.cached_at,
      generalisation_deg = excluded.generalisation_deg
  `);

  const selectGeometry = db.prepare('SELECT geometry_json FROM geometries WHERE feature_id = ?');
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
      if (namelessRows === 'skip') {
        stats.skippedNameless++;
        return;
      }
      throw new Error(
        `Row ${key} of "${source.name}" has no value in any declared name field [${nameFields.join(', ')}]. ` +
          `A nameless feature cannot be searched for.`,
      );
    }

    // Reject nonsense geometry rather than poisoning the R-tree with it.
    let bbox: Bbox | null = row.bbox;
    if (bbox) {
      const ok = bboxPolicy === 'intersects' ? intersectsCanada(bbox) : withinCanada(bbox).ok;
      if (!ok) {
        stats.bboxRejected++;
        const reason =
          bboxPolicy === 'intersects'
            ? `does not overlap Canada at all`
            : withinCanada(bbox).reason;
        console.warn(`[ingest] ${source.name} ${key}: bbox rejected -- ${reason ?? 'outside Canada'}`);
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

    // Tier B geometry, cached the moment it is read.
    //
    // When identity_field merges several rows into one feature, each row carries only its
    // own polygon. Writing them in turn would leave the feature holding whichever part
    // happened to come last -- an island instead of a riding. So a second part for a key
    // is merged with what is already stored, read back from the row rather than held in
    // memory: a national dissemination-area file has half a million records and buffering
    // their geometry to merge a handful of multipart ones would be absurd.
    if (hasGeometry(row)) {
      let geometry = row.geometry;
      let vertexCount = row.vertexCount;

      if (existing && identityField) {
        const prior = selectGeometry.get(rowId) as { geometry_json: string } | undefined;
        if (prior) {
          const merged = mergeGeometries([
            JSON.parse(prior.geometry_json) as Geometry,
            geometry as Geometry,
          ]);
          geometry = merged;
          vertexCount = countVertices(merged);
        }
      }

      upsertGeometry.run({
        feature_id: rowId,
        geometry_json: JSON.stringify(geometry),
        vertex_count: vertexCount,
        source_srid: 4326,
        content_hash: null,
        cached_at: new Date().toISOString(),
        generalisation_deg: null,
      });
      stats.geometriesWritten++;
    }
  };

  const writeBatch = db.transaction((rows: IndexedRow[]) => {
    for (const r of rows) writeOne(r);
  });

  return { writeBatch, stats };
}
