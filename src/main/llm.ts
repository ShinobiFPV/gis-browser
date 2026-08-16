import type { Candidate } from '@shared/types';
import type { ParsedQuery } from '@resolve/parse';
import {
  applyRanking,
  coerceParse,
  extractJsonObject,
  parseResponseSchema,
  parseSystemPrompt,
  rankResponseSchema,
  rankSystemPrompt,
  toRankView,
  PARSE_JSON_SCHEMA,
  RANK_JSON_SCHEMA,
  type RankCandidateView,
} from '@resolve/llm-contract';
import { LlmUnavailableError, modelInfo, type MessageClient } from './anthropic';

/**
 * The Claude parse and rank passes.
 *
 * Both are best-effort by construction: every failure path throws LlmUnavailableError and
 * the caller falls back to the local resolver. An artist on deadline must never be blocked
 * because an API call was slow, rate limited, or returned something unexpected.
 */

export interface LlmParseResult {
  parsed: ParsedQuery;
  notes: string[];
}

export async function llmParse(client: MessageClient, model: string, prompt: string): Promise<LlmParseResult> {
  const info = modelInfo(model);

  const result = await client.send({
    model,
    system: parseSystemPrompt(),
    user: prompt,
    maxTokens: 2048,
    timeoutMs: 30_000,
    // Schema enforcement where the model supports it; prompt-only where it does not.
    // Either way the response is validated with zod below, so the difference is how often
    // the fallback fires, not whether bad data can get through.
    ...(info.structuredOutputs ? { jsonSchema: PARSE_JSON_SCHEMA } : {}),
    ...(info.effort ? { effort: 'low' as const } : {}),
  });

  let raw: unknown;
  try {
    raw = extractJsonObject(result.text);
  } catch (err) {
    throw new LlmUnavailableError(err instanceof Error ? err.message : String(err), 'bad-response');
  }

  const validated = parseResponseSchema.safeParse(raw);
  if (!validated.success) {
    throw new LlmUnavailableError(
      `Claude's parse did not match the expected shape: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .slice(0, 3)
        .join('; ')}`,
      'bad-response',
    );
  }

  const coerced = coerceParse(validated.data);
  if (coerced.placeNames.length === 0) {
    throw new LlmUnavailableError('Claude returned no usable place name.', 'bad-response');
  }

  const notes: string[] = [];
  if (coerced.discarded.length > 0) {
    notes.push(`Claude returned values outside the taxonomy, ignored: ${coerced.discarded.join(', ')}`);
  }

  return {
    parsed: {
      placeNames: coerced.placeNames,
      featureTypeHint: coerced.featureTypeHint,
      jurisdictionHint: coerced.jurisdictionHint,
      vintageHint: coerced.vintageHint,
      wants: coerced.wants,
      notes: coerced.notes || 'parsed by Claude',
      via: 'llm',
    },
    notes,
  };
}

function rankUserMessage(prompt: string, view: RankCandidateView[]): string {
  return [
    'The artist asked for:',
    JSON.stringify(prompt),
    '',
    'Candidates:',
    JSON.stringify(view, null, 1),
  ].join('\n');
}

export async function llmRank(
  client: MessageClient,
  model: string,
  prompt: string,
  candidates: Candidate[],
  attributesFor: (featureId: number) => Record<string, unknown>,
): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;

  const info = modelInfo(model);
  const view = toRankView(candidates, attributesFor);

  const result = await client.send({
    model,
    system: rankSystemPrompt(),
    user: rankUserMessage(prompt, view),
    // Ranking is the judgement call, so it gets thinking room and a larger ceiling than
    // the parse. max_tokens caps thinking plus text together.
    maxTokens: 8192,
    timeoutMs: 60_000,
    ...(info.structuredOutputs ? { jsonSchema: RANK_JSON_SCHEMA } : {}),
    ...(info.effort ? { effort: 'medium' as const } : {}),
    ...(info.adaptiveThinking ? { adaptiveThinking: true } : {}),
  });

  let raw: unknown;
  try {
    raw = extractJsonObject(result.text);
  } catch (err) {
    throw new LlmUnavailableError(err instanceof Error ? err.message : String(err), 'bad-response');
  }

  const validated = rankResponseSchema.safeParse(raw);
  if (!validated.success) {
    throw new LlmUnavailableError("Claude's ranking did not match the expected shape.", 'bad-response');
  }

  return applyRanking(candidates, validated.data);
}
