import { getDb } from '@db/index';
import type { SearchRequest, SearchResponse } from '@shared/ipc';
import { resolve as resolveLocal } from '@resolve/resolve';
import { LlmUnavailableError, SdkMessageClient, type MessageClient } from './anthropic';
import { llmParse, llmRank } from './llm';
import { hasKey } from './keychain';
import { getSetting } from './settings';

/**
 * The full search path: Claude parse -> local match -> Claude rank, with the local
 * resolver underneath every step.
 *
 * The LLM is an enhancement, never a dependency. If the key is missing, the API is down,
 * rate limited, slow, or returns something unexpected, the search still completes using
 * the local resolver and the UI says which path ran. That is not defensive
 * over-engineering -- it is the difference between a degraded search and no search at all
 * five minutes before air.
 */

let client: MessageClient = new SdkMessageClient();

/** Test seam. */
export function setMessageClient(next: MessageClient): void {
  client = next;
}

function attributesFor(featureId: number): Record<string, unknown> {
  const row = getDb().prepare('SELECT attributes_json FROM features WHERE id = ?').get(featureId) as
    | { attributes_json: string }
    | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.attributes_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runSearch(req: SearchRequest): Promise<SearchResponse> {
  const db = getDb();
  const notes: string[] = [];
  const limit = req.limit ?? 15;
  const model = getSetting('anthropicModel');

  const useLlm = req.useLlm && hasKey();
  if (req.useLlm && !hasKey()) {
    notes.push('Claude is switched on but no API key is stored; ran the local resolver instead.');
  }

  // --- 1. Parse -------------------------------------------------------------
  let parsedOverride: Awaited<ReturnType<typeof llmParse>>['parsed'] | undefined;
  let parseMs = 0;

  if (useLlm) {
    const started = Date.now();
    try {
      const r = await llmParse(client, model, req.prompt);
      parsedOverride = r.parsed;
      notes.push(...r.notes);
    } catch (err) {
      notes.push(`Claude parse unavailable (${describe(err)}); used the keyword parser.`);
    }
    parseMs = Date.now() - started;
  }

  // --- 2. Match (always local) ---------------------------------------------
  const local = resolveLocal(db, req.prompt, {
    featureTypeFilter: req.featureTypeFilter ?? null,
    jurisdictionFilter: req.jurisdictionFilter ?? null,
    limit,
    ...(parsedOverride ? { parsed: parsedOverride } : {}),
  });
  notes.push(...local.notes);

  // --- 3. Rank --------------------------------------------------------------
  let candidates = local.candidates;
  let rankMs = local.timings.rankMs;

  if (useLlm && candidates.length > 1) {
    const started = Date.now();
    try {
      candidates = await llmRank(client, model, req.prompt, candidates, attributesFor);
    } catch (err) {
      notes.push(`Claude ranking unavailable (${describe(err)}); kept the local ranking.`);
    }
    rankMs += Date.now() - started;
  }

  return {
    candidates,
    parsed: {
      placeNames: local.parsed.placeNames,
      featureTypeHint: local.parsed.featureTypeHint,
      jurisdictionHint: local.parsed.jurisdictionHint,
      vintageHint: local.parsed.vintageHint,
      wants: local.parsed.wants,
      notes: [local.parsed.notes, ...notes].filter(Boolean).join('; '),
      via: local.parsed.via,
    },
    timings: { parseMs: parseMs || local.timings.parseMs, matchMs: local.timings.matchMs, rankMs },
  };
}

function describe(err: unknown): string {
  if (err instanceof LlmUnavailableError) return `${err.reason}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
