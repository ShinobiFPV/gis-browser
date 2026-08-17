import { getDb } from '@db/index';
import type { DiscoveredRow, DiscoveryRunRequest, DiscoveryRunResult } from '@shared/ipc';
import { isFeatureType } from '@shared/taxonomy';
import { asText } from '@shared/scalar';
import { HttpClient } from '../harvester/http';
import { runDiscovery, type DiscoveryProgress } from '../harvester/discovery/run-discovery';
import { DISCOVERY_CATALOGS } from '@db/seed/sources';

/**
 * Discovery, driven from the UI.
 *
 * Runs in main rather than the harvester utilityProcess: it is interactive, short, and
 * must not queue behind a 197 MB Tier B download that happens to be in flight.
 */

const CKAN_ROOTS = DISCOVERY_CATALOGS.filter((c) => c.kind === 'ckan').map((c) => ({
  name: c.name,
  endpoint: c.endpoint,
}));

let inFlight: Promise<DiscoveryRunResult> | null = null;
let client: HttpClient | null = null;

export function cancelDiscovery(): void {
  client?.cancel();
}

export async function runDiscoveryJob(
  req: DiscoveryRunRequest,
  onProgress: (p: DiscoveryProgress) => void,
): Promise<DiscoveryRunResult> {
  if (inFlight) throw new Error('A discovery crawl is already running.');

  const queries = (req.queries ?? []).map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) throw new Error('Give discovery at least one search term.');

  client = new HttpClient({
    log: (level, message) => {
      if (level === 'warn' || level === 'error') console.warn(`[discovery] ${message}`);
    },
  });

  inFlight = runDiscovery(
    getDb(),
    client,
    {
      queries,
      maxPages: 2,
      maxValidations: req.maxValidations ?? 40,
      ckanRoots: CKAN_ROOTS,
    },
    { onProgress, log: (level, message) => console.log(`[discovery:${level}] ${message}`) },
  );

  try {
    return await inFlight;
  } finally {
    inFlight = null;
    client = null;
  }
}

export function listDiscovered(): DiscoveredRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, catalog, title, endpoint, layer_id, kind, publisher, feature_type, jurisdiction,
              name_fields, live_count, confidence, concerns, validated, validation_error, decision
       FROM discovered_sources
       ORDER BY CASE decision WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
                confidence DESC, title`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r['id'] as number,
    catalog: r['catalog'] as string,
    title: r['title'] as string,
    endpoint: r['endpoint'] as string,
    layerId: (r['layer_id'] as string) ?? '',
    kind: r['kind'] as string,
    publisher: (r['publisher'] as string | null) ?? null,
    featureType: (r['feature_type'] as string | null) ?? null,
    jurisdiction: (r['jurisdiction'] as string | null) ?? null,
    nameFields: JSON.parse((r['name_fields'] as string) || '[]') as string[],
    liveCount: (r['live_count'] as number | null) ?? null,
    confidence: (r['confidence'] as number) ?? 0,
    concerns: JSON.parse((r['concerns'] as string) || '[]') as string[],
    validated: Boolean(r['validated']),
    validationError: (r['validation_error'] as string | null) ?? null,
    decision: r['decision'] as 'new' | 'accepted' | 'rejected',
  }));
}

/**
 * Promotes a candidate into the registry, or records a rejection.
 *
 * Accepting writes a real source with status 'seeded', so it appears in the Sources pane
 * unharvested and the person still has to choose to harvest it. Nothing is indexed as a
 * side effect of a single click.
 *
 * The licence is written as unconfirmed on purpose. Catalogs report licences as 'none' or
 * 'custom' or a block of HTML far more often than as anything usable, and a boundary that
 * goes to air needs a licence somebody checked, not one a crawler guessed.
 */
export function decideCandidate(id: number, decision: 'accepted' | 'rejected'): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM discovered_sources WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { ok: false, error: `No discovered source with id ${id}` };

  if (decision === 'rejected') {
    db.prepare("UPDATE discovered_sources SET decision = 'rejected', decided_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { ok: true };
  }

  const featureType = row['feature_type'];
  if (typeof featureType !== 'string' || !isFeatureType(featureType)) {
    return {
      ok: false,
      error:
        `"${String(row['title'])}" has no recognised boundary type, so it cannot be added. ` +
        `The taxonomy is closed by design — a source filed under a type nobody searches for ` +
        `would never be found.`,
    };
  }

  const nameFields = JSON.parse((row['name_fields'] as string) || '[]') as string[];
  if (nameFields.length === 0) {
    return {
      ok: false,
      error:
        `"${String(row['title'])}" has no field that looks like a name, so its boundaries ` +
        `could not be searched for. Nothing to index.`,
    };
  }

  if (!row['validated']) {
    return {
      ok: false,
      error:
        `"${asText(row['title'], 'This candidate')}" did not answer when its endpoint was ` +
        `checked: ${asText(row['validation_error'], 'unknown error')}`,
    };
  }

  const insert = db.prepare(`
    INSERT INTO sources (
      name, kind, tier, endpoint, layer_id, feature_type, jurisdiction, vintage,
      licence, attribution, name_fields, status, source_srid, verified_count, verified_at, notes
    ) VALUES (
      @name, @kind, 'A', @endpoint, @layer_id, @feature_type, @jurisdiction, 'current',
      @licence, @attribution, @name_fields, 'seeded', @source_srid, @verified_count, @verified_at, @notes
    )
    ON CONFLICT(endpoint, layer_id, feature_type) DO NOTHING
  `);

  const concerns = JSON.parse((row['concerns'] as string) || '[]') as string[];

  insert.run({
    name: String(row['title']),
    kind: String(row['kind']),
    endpoint: String(row['endpoint']),
    layer_id: asText(row['layer_id'], ''),
    feature_type: featureType,
    jurisdiction: row['jurisdiction'] ?? null,
    licence: 'Unconfirmed — accepted from a catalog crawl; verify before broadcast use',
    attribution: row['publisher'] ?? 'Unknown publisher',
    name_fields: JSON.stringify(nameFields),
    source_srid: row['source_srid'] ?? null,
    verified_count: row['live_count'] ?? null,
    verified_at: new Date().toISOString().slice(0, 10),
    notes:
      `Added from ${String(row['catalog'])} discovery.` +
      (concerns.length ? ` Outstanding concerns: ${concerns.join(' ')}` : ''),
  });

  db.prepare("UPDATE discovered_sources SET decision = 'accepted', decided_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );

  return { ok: true };
}
