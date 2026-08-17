import { HttpError, ServiceError, type HttpClient } from '../http';
import * as esri from '../catalogs/esri-rest';
import * as wfs from '../catalogs/ogc-wfs';
import type { DiscoveredCandidate } from './classify';

/**
 * Confirming a discovered endpoint is real before it is offered.
 *
 * The brief's rule -- verify every endpoint with a live request before hardcoding it --
 * applies with more force to a crawler than to a hand-written registry, because nobody
 * looked at these URLs at all. A catalog entry is a claim: the service may be gone, the
 * layer may be a table with no geometry, the record count may be nothing like advertised.
 *
 * A failed check is never fatal to the crawl. It is recorded against the candidate and
 * shown, because "this one is dead" is a useful answer.
 */

export interface ValidationResult {
  ok: boolean;
  /** Features the service itself reports. The catalog's own count is only a claim. */
  liveCount: number | null;
  /** Fields the service declares, which beat the catalog's fieldNames. */
  fields: string[];
  geometryType: string | null;
  srid: number | null;
  /** Populated when ok is false. Carries HTTP status and URL, never a bare message. */
  error: string | null;
  elapsedMs: number;
}

/** Splits an ESRI layer URL into its service endpoint and layer id. */
export function splitEsriUrl(url: string): { endpoint: string; layerId: string } | null {
  const match = /^(.*\/(?:Feature|Map)Server)\/(\d+)\/?$/i.exec(url.trim());
  if (match) return { endpoint: match[1]!, layerId: match[2]! };

  // A service URL with no layer index. Layer 0 is the convention but not a guarantee, so
  // it is recorded as a guess rather than presented as fact.
  const service = /^(.*\/(?:Feature|Map)Server)\/?$/i.exec(url.trim());
  if (service) return { endpoint: service[1]!, layerId: '0' };

  return null;
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof ServiceError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export async function validateCandidate(
  http: HttpClient,
  candidate: DiscoveredCandidate,
): Promise<ValidationResult> {
  const started = Date.now();
  const fail = (error: string): ValidationResult => ({
    ok: false,
    liveCount: null,
    fields: [],
    geometryType: null,
    srid: null,
    error,
    elapsedMs: Date.now() - started,
  });

  try {
    if (candidate.kind === 'esri-rest') {
      const split = splitEsriUrl(candidate.endpoint);
      if (!split) return fail(`Not an ESRI layer URL: ${candidate.endpoint}`);

      const meta = await esri.fetchLayerMeta(http, split.endpoint, split.layerId);
      const count = await esri.fetchCount(http, split.endpoint, split.layerId);

      const fields = meta.fields.map((f) => f.name);
      if (!meta.geometryType) {
        return fail('The layer publishes no geometry type, so it is a table rather than boundaries.');
      }

      return {
        ok: true,
        liveCount: count,
        fields,
        geometryType: meta.geometryType,
        srid: meta.extentWkid ?? candidate.srid,
        error: null,
        elapsedMs: Date.now() - started,
      };
    }

    if (candidate.kind === 'wfs') {
      const meta = await wfs.fetchCapabilities(http, candidate.endpoint, candidate.catalogId);
      const props = await wfs.describeFeatureType(http, candidate.endpoint, meta.typeName);
      const count = await wfs.fetchHits(http, candidate.endpoint, meta.typeName);

      return {
        ok: true,
        liveCount: count,
        fields: props.map((p) => p.name),
        geometryType: wfs.geometryPropertyOf(props) ? 'Polygon' : null,
        srid: meta.defaultCrsSrid ?? candidate.srid,
        error: null,
        elapsedMs: Date.now() - started,
      };
    }

    // Bulk files are not fetched during discovery -- that would mean downloading hundreds
    // of megabytes to answer a question nobody has asked yet. They are proposed unvalidated
    // and say so.
    return {
      ok: true,
      liveCount: null,
      fields: [],
      geometryType: null,
      srid: candidate.srid,
      error: null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return fail(describeError(err));
  }
}
