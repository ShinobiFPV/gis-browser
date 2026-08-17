import type { HttpClient } from '../../harvester/http';
import { HttpError } from '../../harvester/http';
import {
  LlmUnavailableError,
  type MessageClient,
  type MessageRequest,
  type MessageResult,
} from '../llm-types';
import { statusToUnavailable, trimSlash } from './openai';

/**
 * Google Gemini, via generateContent.
 *
 * Its own shape rather than an OpenAI clone: the system prompt is systemInstruction, the
 * user turn is contents[], and structured output is responseMimeType plus responseSchema
 * inside generationConfig.
 *
 * The key goes in the x-goog-api-key HEADER, not the ?key= query parameter Google's own
 * examples use. The HTTP client logs the URL of every request, and a key in the query
 * string would be written into a log file permanently.
 */
export class GeminiClient implements MessageClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly getKey: () => string | null,
  ) {}

  async send(request: MessageRequest): Promise<MessageResult> {
    const key = this.getKey();
    if (!key) {
      throw new LlmUnavailableError('No Google Gemini API key is stored. Add one in Settings.', 'no-key');
    }

    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.maxTokens };
    if (request.jsonSchema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(request.jsonSchema);
    }

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig,
    };

    const url = `${trimSlash(this.baseUrl)}/models/${encodeURIComponent(request.model)}:generateContent`;

    const started = Date.now();
    let res: { ok: boolean; status: number; text: string };
    try {
      res = await this.http.postJson(url, body, {
        headers: { 'x-goog-api-key': key },
        timeoutMs: request.timeoutMs,
      });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      throw new LlmUnavailableError(`Could not reach Google Gemini: ${message}`, 'network');
    }

    if (!res.ok) throw statusToUnavailable(res.status, res.text, 'Google Gemini');

    let parsed: GeminiResponse;
    try {
      parsed = JSON.parse(res.text) as GeminiResponse;
    } catch {
      throw new LlmUnavailableError(
        `Google Gemini returned a body that is not JSON: ${res.text.slice(0, 200)}`,
        'bad-response',
      );
    }

    const candidate = parsed.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      throw new LlmUnavailableError('Google Gemini blocked this request on safety grounds.', 'refusal');
    }

    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text.trim()) {
      throw new LlmUnavailableError(
        `Google Gemini returned no text (finishReason ${candidate?.finishReason ?? 'unknown'}).`,
        'bad-response',
      );
    }

    console.log(
      `[llm] gemini ${request.model} ${Date.now() - started}ms ` +
        `in=${parsed.usageMetadata?.promptTokenCount ?? 0} out=${parsed.usageMetadata?.candidatesTokenCount ?? 0} ` +
        `stop=${candidate?.finishReason ?? '?'}`,
    );

    return {
      text,
      stopReason: candidate?.finishReason ?? null,
      inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Trims a JSON Schema down to the subset Gemini's responseSchema accepts.
 *
 * It rejects `additionalProperties` outright, and ignores `$schema` and `const`. Our
 * contract schemas carry additionalProperties:false everywhere, so sending them verbatim
 * is a 400 -- and the failure looks like a broken provider rather than a schema quibble.
 * Dropping the unsupported keys keeps schema enforcement working here.
 */
export function toGeminiSchema(schema: object): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'additionalProperties' || key === '$schema' || key === 'const') continue;
      // Gemini takes a single type, not a union, so ['string','null'] becomes 'string'
      // and nullability is expressed with `nullable`.
      if (key === 'type' && Array.isArray(value)) {
        const types = value.filter((t): t is string => typeof t === 'string');
        const nonNull = types.find((t) => t !== 'null') ?? 'string';
        out['type'] = nonNull;
        if (types.includes('null')) out['nullable'] = true;
        continue;
      }
      out[key] = strip(value);
    }
    return out;
  };

  return strip(schema);
}
