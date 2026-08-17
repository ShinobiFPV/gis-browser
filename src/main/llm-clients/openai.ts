import type { HttpClient } from '../../harvester/http';
import { HttpError } from '../../harvester/http';
import {
  excerptProviderError,
  LlmUnavailableError,
  type MessageClient,
  type MessageRequest,
  type MessageResult,
} from '../llm-types';

/**
 * Anything speaking the OpenAI chat-completions API.
 *
 * OpenAI itself, and everything that copied the shape: OpenRouter, Groq, Together,
 * DeepSeek, xAI, and the local runtimes -- Ollama, LM Studio, vLLM. One client covers all
 * of them because the only thing that differs is the base URL and whether a key is needed.
 *
 * Raw HTTP rather than the openai SDK, because adding a dependency needs asking first and
 * this endpoint is three fields. It goes through the shared HttpClient so it inherits the
 * same timeout, retry and per-host concurrency rules as every other request the app makes.
 */
export class OpenAiCompatibleClient implements MessageClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly getKey: () => string | null,
    private readonly keyRequired: boolean,
    private readonly providerLabel: string,
  ) {}

  async send(request: MessageRequest): Promise<MessageResult> {
    const key = this.getKey();
    if (this.keyRequired && !key) {
      throw new LlmUnavailableError(`No ${this.providerLabel} API key is stored. Add one in Settings.`, 'no-key');
    }

    const body: Record<string, unknown> = {
      model: request.model,
      // The system prompt is a message here rather than a top-level field.
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_completion_tokens: request.maxTokens,
    };

    if (request.jsonSchema) {
      // Strict structured outputs. The schema must be named, and additionalProperties
      // false throughout -- which the contract's schemas already are.
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: 'gis_browser_response', strict: true, schema: request.jsonSchema },
      };
    }
    if (request.effort) body['reasoning_effort'] = request.effort;
    // adaptiveThinking is Anthropic's, and has no equivalent here.

    const headers: Record<string, string> = {};
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const started = Date.now();
    let res: { ok: boolean; status: number; text: string };
    try {
      res = await this.http.postJson(`${trimSlash(this.baseUrl)}/chat/completions`, body, {
        headers,
        timeoutMs: request.timeoutMs,
      });
    } catch (err) {
      // Transport failure or timeout. A local runtime that is not running lands here.
      const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
      throw new LlmUnavailableError(`Could not reach ${this.providerLabel}: ${message}`, 'network');
    }

    if (!res.ok) throw statusToUnavailable(res.status, res.text, this.providerLabel);

    let parsed: OpenAiResponse;
    try {
      parsed = JSON.parse(res.text) as OpenAiResponse;
    } catch {
      throw new LlmUnavailableError(
        `${this.providerLabel} returned a body that is not JSON: ${res.text.slice(0, 200)}`,
        'bad-response',
      );
    }

    const choice = parsed.choices?.[0];
    const text = choice?.message?.content ?? '';

    if (choice?.finish_reason === 'content_filter') {
      throw new LlmUnavailableError(`${this.providerLabel} filtered this request.`, 'refusal');
    }
    if (!text.trim()) {
      throw new LlmUnavailableError(
        `${this.providerLabel} returned no text (finish_reason ${choice?.finish_reason ?? 'unknown'}).`,
        'bad-response',
      );
    }

    console.log(
      `[llm] openai-compatible ${request.model} ${Date.now() - started}ms ` +
        `in=${parsed.usage?.prompt_tokens ?? 0} out=${parsed.usage?.completion_tokens ?? 0} ` +
        `stop=${choice?.finish_reason ?? '?'}`,
    );

    return {
      text,
      stopReason: choice?.finish_reason ?? null,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
    };
  }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Shared by both HTTP clients: an HTTP status becomes a fallback reason. */
export function statusToUnavailable(status: number, body: string, label: string): LlmUnavailableError {
  const detail = excerptProviderError(body);
  if (status === 401 || status === 403) {
    return new LlmUnavailableError(`The stored ${label} API key was rejected: ${detail}`, 'auth');
  }
  if (status === 429) {
    return new LlmUnavailableError(`Rate limited by ${label}: ${detail}`, 'rate-limit');
  }
  if (status === 404) {
    // Overwhelmingly a model id that does not exist on this endpoint, which is easy to
    // do when the model is typed in by hand.
    return new LlmUnavailableError(
      `${label} returned 404. The model id or base URL is probably wrong: ${detail}`,
      'api',
    );
  }
  if (status >= 500) {
    return new LlmUnavailableError(`${label} is having trouble (HTTP ${status}): ${detail}`, 'api');
  }
  return new LlmUnavailableError(`${label} returned HTTP ${status}: ${detail}`, 'api');
}
