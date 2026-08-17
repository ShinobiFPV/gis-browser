import type { Db } from '@db/index';
import { intersectsCanada } from '../normalize/crs';
import type { HttpClient } from '../http';
import { searchDatasets, type HubDataset } from '../catalogs/arcgis-hub';
import { classifyResource, searchPackages, type CkanPackage } from '../catalogs/ckan';
import { assess, classifyFeatureType, inferJurisdiction, pickNameFields, type DiscoveredCandidate } from './classify';
import { splitEsriUrl, validateCandidate } from './validate';

/**
 * The crawl.
 *
 *   search a catalog -> keep what is plausibly Canadian -> classify -> drop what we
 *   already have -> validate live -> store as a candidate for review
 *
 * Live validation happens LAST and only on survivors. Hub reports 657,212 matches for
 * "electoral district"; validating before filtering would mean tens of thousands of
 * requests to services in other countries to answer a question about Canada.
 */

export interface DiscoveryProgress {
  phase: 'searching' | 'validating' | 'done';
  catalog: string;
  seen: number;
  kept: number;
  validated: number;
  message: string;
}

export interface DiscoveryCallbacks {
  onProgress: (p: DiscoveryProgress) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface DiscoveryOptions {
  /** Search terms. Each is run against every catalog. */
  queries: string[];
  /** Pages per query per catalog. Guards against walking a 657k-row result set. */
  maxPages?: number;
  /** Candidates to validate live per run. Validation is the slow, polite part. */
  maxValidations?: number;
  hubApiRoot?: string;
  ckanRoots?: { name: string; endpoint: string }[];
}

export interface DiscoveryResult {
  seen: number;
  /** Passed the Canada and classification filters. */
  kept: number;
  /** Already in the registry, or already discovered. */
  duplicates: number;
  validated: number;
  reachable: number;
  written: number;
  warnings: string[];
}

/** Datasets with no geometry cannot be boundaries, whatever they are called. */
const NON_SPATIAL_TYPES = new Set(['table', 'csv collection', 'document link', 'web map', 'web mapping application']);

function isPlausiblyCanadian(dataset: HubDataset): boolean {
  // No extent is not disqualifying on its own -- some good layers publish none -- but an
  // extent that is definitely elsewhere is.
  if (!dataset.extent) return true;
  return intersectsCanada({
    minx: dataset.extent.minLon,
    miny: dataset.extent.minLat,
    maxx: dataset.extent.maxLon,
    maxy: dataset.extent.maxLat,
  });
}

export function hubToCandidate(dataset: HubDataset): DiscoveredCandidate | null {
  if (!dataset.url) return null;
  if (dataset.type && NON_SPATIAL_TYPES.has(dataset.type.toLowerCase())) return null;
  if (!splitEsriUrl(dataset.url)) return null;

  const featureType = classifyFeatureType(dataset.name, dataset.tags.join(' '), dataset.description);
  const { jurisdiction, via } = inferJurisdiction(dataset.name, dataset.source, dataset.extent);
  const nameFields = pickNameFields(dataset.fieldNames);

  const { confidence, concerns } = assess({
    title: dataset.name,
    featureType,
    jurisdiction,
    extent: dataset.extent,
    recordCount: dataset.recordCount,
    nameFields,
    licence: dataset.licence,
    publisher: dataset.source,
    endpoint: dataset.url,
    jurisdictionVia: via,
  });

  return {
    catalog: 'arcgis-hub',
    catalogId: dataset.id,
    title: dataset.name,
    endpoint: dataset.url,
    kind: 'esri-rest',
    publisher: dataset.source,
    extent: dataset.extent,
    recordCount: dataset.recordCount,
    srid: dataset.srid,
    fieldNames: dataset.fieldNames,
    licence: dataset.licence,
    description: dataset.description,
    featureType,
    jurisdiction,
    jurisdictionVia: via,
    nameFields,
    confidence,
    concerns,
  };
}

export function ckanToCandidates(pkg: CkanPackage): DiscoveredCandidate[] {
  const out: DiscoveredCandidate[] = [];

  for (const resource of pkg.resources) {
    const kind = classifyResource(resource);
    if (!kind || !resource.url) continue;

    const featureType = classifyFeatureType(pkg.title, pkg.tags.join(' '), pkg.notes);
    const { jurisdiction, via } = inferJurisdiction(pkg.title, pkg.organization, null);

    const { confidence, concerns } = assess({
      title: pkg.title,
      featureType,
      jurisdiction,
      extent: null,
      recordCount: null,
      // CKAN publishes no field list, so name fields cannot be proposed until the
      // endpoint is validated and the service tells us what it has.
      nameFields: [],
      licence: pkg.licence,
      publisher: pkg.organization,
      endpoint: resource.url,
      jurisdictionVia: via,
    });

    if (kind === 'bulk-file') {
      concerns.push('A file download. Its size and contents are unknown until it is fetched.');
    }

    out.push({
      catalog: 'ckan',
      catalogId: `${pkg.id}:${resource.id ?? resource.name ?? '0'}`,
      title: resource.name && resource.name !== pkg.title ? `${pkg.title} — ${resource.name}` : pkg.title,
      endpoint: resource.url,
      kind,
      publisher: pkg.organization,
      extent: null,
      recordCount: null,
      srid: null,
      fieldNames: [],
      licence: pkg.licence,
      description: pkg.notes,
      featureType,
      jurisdiction,
      jurisdictionVia: via,
      nameFields: [],
      confidence,
      concerns,
    });
  }

  return out;
}

/** Endpoints already in the registry, normalised so a trailing slash is not a new source. */
function existingEndpoints(db: Db): Set<string> {
  const rows = db.prepare('SELECT endpoint, layer_id FROM sources').all() as {
    endpoint: string;
    layer_id: string | null;
  }[];
  const set = new Set<string>();
  for (const r of rows) {
    set.add(normaliseEndpoint(r.endpoint, r.layer_id ?? ''));
    set.add(normaliseEndpoint(r.endpoint, ''));
  }
  return set;
}

/**
 * Round-robins an already-sorted list so no one publisher-and-type group monopolises the
 * front of it. Order within a group is preserved, so each group still leads with its best.
 */
export function interleaveByGroup(sorted: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const groups = new Map<string, DiscoveredCandidate[]>();
  for (const c of sorted) {
    const key = `${(c.publisher ?? '?').toLowerCase()}|${c.featureType ?? '?'}|${c.jurisdiction ?? '?'}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  const queues = [...groups.values()];
  const out: DiscoveredCandidate[] = [];
  for (let round = 0; out.length < sorted.length; round++) {
    let progressed = false;
    for (const queue of queues) {
      const next = queue[round];
      if (next) {
        out.push(next);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export function normaliseEndpoint(endpoint: string, layerId: string): string {
  const base = endpoint.trim().replace(/\/+$/, '').toLowerCase();
  return layerId ? `${base}/${layerId}` : base;
}

export async function runDiscovery(
  db: Db,
  http: HttpClient,
  opts: DiscoveryOptions,
  cb: DiscoveryCallbacks,
): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const result: DiscoveryResult = {
    seen: 0,
    kept: 0,
    duplicates: 0,
    validated: 0,
    reachable: 0,
    written: 0,
    warnings,
  };

  const known = existingEndpoints(db);
  const candidates = new Map<string, DiscoveredCandidate>();

  const consider = (candidate: DiscoveredCandidate): void => {
    const split = candidate.kind === 'esri-rest' ? splitEsriUrl(candidate.endpoint) : null;
    const key = normaliseEndpoint(split?.endpoint ?? candidate.endpoint, split?.layerId ?? '');

    if (known.has(key)) {
      result.duplicates++;
      return;
    }
    if (candidates.has(key)) return;

    candidates.set(key, candidate);
    result.kept++;
  };

  // --- ArcGIS Hub ----------------------------------------------------------------
  for (const q of opts.queries) {
    if (http.isCancelled) break;
    try {
      for await (const page of searchDatasets(http, { q, maxPages: opts.maxPages ?? 2 }, opts.hubApiRoot)) {
        result.seen += page.datasets.length;

        for (const dataset of page.datasets) {
          if (!isPlausiblyCanadian(dataset)) continue;
          const candidate = hubToCandidate(dataset);
          if (candidate) consider(candidate);
        }

        cb.onProgress({
          phase: 'searching',
          catalog: 'ArcGIS Hub',
          seen: result.seen,
          kept: result.kept,
          validated: 0,
          message: `"${q}" page ${page.pageNumber}${page.totalCount ? ` of ${page.totalCount} matches` : ''}`,
        });
      }
    } catch (err) {
      const message = `ArcGIS Hub search for "${q}" failed: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(message);
      cb.log('warn', message);
    }
  }

  // --- CKAN ----------------------------------------------------------------------
  for (const catalog of opts.ckanRoots ?? []) {
    for (const q of opts.queries) {
      if (http.isCancelled) break;
      try {
        for await (const page of searchPackages(http, catalog.endpoint, { q, maxPages: opts.maxPages ?? 2 })) {
          result.seen += page.packages.length;
          for (const pkg of page.packages) for (const c of ckanToCandidates(pkg)) consider(c);

          cb.onProgress({
            phase: 'searching',
            catalog: catalog.name,
            seen: result.seen,
            kept: result.kept,
            validated: 0,
            message: `"${q}" from ${page.start}${page.totalCount ? ` of ${page.totalCount} matches` : ''}`,
          });
        }
      } catch (err) {
        const message = `${catalog.name} search for "${q}" failed: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        cb.log('warn', message);
      }
    }
  }

  cb.log('info', `discovery: ${result.seen} results seen, ${result.kept} candidates, ${result.duplicates} already known`);

  /*
   * Validate best first, and spread the budget across distinct datasets.
   *
   * B.C.'s Map Hub publishes five near-identical "Provincial Electoral Districts -
   * Electoral Boundaries Redistribution" layers, plus a TEST mirror of each. Left alone
   * they took a quarter of the validation budget between them and pushed the Government
   * of Yukon's territorial ridings -- the only source for that jurisdiction anywhere in
   * the results -- off the end of the list entirely.
   *
   * So candidates are grouped by publisher and boundary type, and the round-robin takes
   * each group's best before any group's second. Nothing is discarded; the duplicates are
   * still there, just behind one example of everything else.
   */
  const ranked = interleaveByGroup(
    [...candidates.values()].sort((a, b) => b.confidence - a.confidence),
  );
  const budget = opts.maxValidations ?? 40;

  const upsert = db.prepare(`
    INSERT INTO discovered_sources (
      catalog, catalog_id, title, endpoint, layer_id, kind, publisher, feature_type,
      jurisdiction, name_fields, source_srid, licence, description, record_count, live_count,
      minx, miny, maxx, maxy, confidence, concerns, validated, validation_error,
      decision, discovered_at
    ) VALUES (
      @catalog, @catalog_id, @title, @endpoint, @layer_id, @kind, @publisher, @feature_type,
      @jurisdiction, @name_fields, @source_srid, @licence, @description, @record_count, @live_count,
      @minx, @miny, @maxx, @maxy, @confidence, @concerns, @validated, @validation_error,
      'new', @discovered_at
    )
    ON CONFLICT(endpoint, layer_id) DO UPDATE SET
      title            = excluded.title,
      feature_type     = excluded.feature_type,
      jurisdiction     = excluded.jurisdiction,
      name_fields      = excluded.name_fields,
      source_srid      = excluded.source_srid,
      live_count       = excluded.live_count,
      confidence       = excluded.confidence,
      concerns         = excluded.concerns,
      validated        = excluded.validated,
      validation_error = excluded.validation_error,
      discovered_at    = excluded.discovered_at
      -- decision is deliberately preserved: a rejection must survive the next crawl.
  `);

  for (const [i, candidate] of ranked.entries()) {
    if (http.isCancelled) break;
    if (i >= budget) {
      warnings.push(
        `Validated the top ${budget} of ${ranked.length} candidates. The rest were left ` +
          `unchecked rather than sending hundreds of requests in one run; raise the limit ` +
          `or narrow the search terms to reach them.`,
      );
      break;
    }

    const validation = await validateCandidate(http, candidate);
    result.validated++;
    if (validation.ok) result.reachable++;

    // The service's own field list beats the catalog's, which is often stale and mixes
    // display aliases in with real field names.
    const nameFields = validation.fields.length > 0 ? pickNameFields(validation.fields) : candidate.nameFields;

    const reassessed = assess({
      title: candidate.title,
      featureType: candidate.featureType,
      jurisdiction: candidate.jurisdiction,
      extent: candidate.extent,
      recordCount: validation.liveCount ?? candidate.recordCount,
      nameFields,
      licence: candidate.licence,
      publisher: candidate.publisher,
      endpoint: candidate.endpoint,
      jurisdictionVia: candidate.jurisdictionVia,
    });

    const concerns = [...reassessed.concerns];
    if (!validation.ok && validation.error) concerns.push(`Endpoint check failed: ${validation.error}`);
    if (
      validation.liveCount !== null &&
      candidate.recordCount !== null &&
      Math.abs(validation.liveCount - candidate.recordCount) > Math.max(5, candidate.recordCount * 0.1)
    ) {
      concerns.push(
        `The catalog advertises ${candidate.recordCount} features but the service reports ` +
          `${validation.liveCount}. The catalog entry is stale.`,
      );
    }

    const split = candidate.kind === 'esri-rest' ? splitEsriUrl(candidate.endpoint) : null;

    upsert.run({
      catalog: candidate.catalog,
      catalog_id: candidate.catalogId,
      title: candidate.title,
      endpoint: split?.endpoint ?? candidate.endpoint,
      layer_id: split?.layerId ?? '',
      kind: candidate.kind,
      publisher: candidate.publisher,
      feature_type: candidate.featureType,
      jurisdiction: candidate.jurisdiction,
      name_fields: JSON.stringify(nameFields),
      source_srid: validation.srid ?? candidate.srid,
      licence: candidate.licence,
      description: candidate.description,
      record_count: candidate.recordCount,
      live_count: validation.liveCount,
      minx: candidate.extent?.minLon ?? null,
      miny: candidate.extent?.minLat ?? null,
      maxx: candidate.extent?.maxLon ?? null,
      maxy: candidate.extent?.maxLat ?? null,
      // A candidate that failed its live check cannot be trusted whatever its title says.
      confidence: validation.ok ? reassessed.confidence : 0,
      concerns: JSON.stringify(concerns),
      validated: validation.ok ? 1 : 0,
      validation_error: validation.error,
      discovered_at: new Date().toISOString(),
    });
    result.written++;

    cb.onProgress({
      phase: 'validating',
      catalog: candidate.catalog,
      seen: result.seen,
      kept: result.kept,
      validated: result.validated,
      message: `${validation.ok ? 'ok' : 'unreachable'} — ${candidate.title.slice(0, 60)}`,
    });
  }

  cb.onProgress({
    phase: 'done',
    catalog: '',
    seen: result.seen,
    kept: result.kept,
    validated: result.validated,
    message: `${result.reachable} of ${result.validated} reachable`,
  });

  return result;
}
