import Anthropic from '@anthropic-ai/sdk';
import { readKey } from './keychain';

/**
 * The Anthropic client lives here and only here.
 *
 * Every call originates in main. The key is read from safeStorage at the moment a request
 * is built, is never handed to the renderer, never written into the SQLite catalog, and
 * never logged — the log lines below deliberately carry model and timing only.
 */

export interface ModelInfo {
  id: string;
  label: string;
  /**
   * Whether the model can be constrained to a JSON Schema via `output_config.format`.
   * When it can, a malformed parse becomes impossible rather than merely unlikely.
   */
  structuredOutputs: boolean;
  /** Whether `output_config.effort` is accepted. */
  effort: boolean;
  /** Whether `thinking: {type: "adaptive"}` is accepted. */
  adaptiveThinking: boolean;
  note?: string;
}

/**
 * The models offered in Settings.
 *
 * The default is the one the brief names. It is a real, current model, but note the
 * capability difference recorded below: it cannot be schema-constrained, so its JSON is
 * requested by prompt and validated afterwards. The other three can be constrained.
 */
export const MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    structuredOutputs: false,
    effort: true,
    adaptiveThinking: true,
    note: 'Specified in the project brief. JSON is requested by prompt and validated, not schema-enforced.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: true,
    note: 'Schema-enforced JSON. Recommended: same tier as the brief’s model, but the parse cannot come back malformed.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: true,
    note: 'Schema-enforced JSON, strongest ranking judgement, highest cost.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
    note: 'Schema-enforced JSON, cheapest and fastest. Does not accept effort or adaptive thinking.',
  },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? { ...MODELS[0]!, id, label: id };
}

/** Raised for anything that should make the caller fall back to the local resolver. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-key' | 'auth' | 'rate-limit' | 'network' | 'refusal' | 'bad-response' | 'api',
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Minimal surface the LLM layer needs. Injectable so the calling logic can be tested
 * without a network, an API key, or the SDK.
 */
export interface MessageClient {
  send(request: MessageRequest): Promise<MessageResult>;
}

export interface MessageRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  /** JSON Schema to constrain the response, when the model supports it. */
  jsonSchema?: object;
  effort?: 'low' | 'medium' | 'high';
  adaptiveThinking?: boolean;
}

export interface MessageResult {
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** Maps SDK errors onto the fallback reasons the resolver understands. */
function toUnavailable(err: unknown): LlmUnavailableError {
  if (err instanceof LlmUnavailableError) return err;

  // Most specific first, as the SDK's typed classes are designed for.
  if (err instanceof Anthropic.AuthenticationError) {
    return new LlmUnavailableError('The stored Anthropic API key was rejected.', 'auth');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new LlmUnavailableError('The API key does not have access to this model.', 'auth');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmUnavailableError('Rate limited by the Anthropic API.', 'rate-limit');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmUnavailableError(`Could not reach the Anthropic API: ${err.message}`, 'network');
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmUnavailableError(`Anthropic API error ${err.status ?? '?'}: ${err.message}`, 'api');
  }
  return new LlmUnavailableError(err instanceof Error ? err.message : String(err), 'api');
}

/** The real client, talking to the Anthropic API with the key from safeStorage. */
export class SdkMessageClient implements MessageClient {
  async send(request: MessageRequest): Promise<MessageResult> {
    const apiKey = readKey();
    if (!apiKey) {
      throw new LlmUnavailableError('No Anthropic API key is stored. Add one in Settings.', 'no-key');
    }

    // Constructed per request so a key change takes effect immediately and no key is
    // held in a long-lived object.
    const client = new Anthropic({ apiKey, maxRetries: 1 });

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    };

    const outputConfig: Record<string, unknown> = {};
    if (request.effort) outputConfig['effort'] = request.effort;
    if (request.jsonSchema) outputConfig['format'] = { type: 'json_schema', schema: request.jsonSchema };
    if (Object.keys(outputConfig).length > 0) body['output_config'] = outputConfig;

    if (request.adaptiveThinking) body['thinking'] = { type: 'adaptive' };

    const started = Date.now();
    let message;
    try {
      // The SDK's timeout is in milliseconds.
      message = await client.messages.create(body as never, { timeout: request.timeoutMs });
    } catch (err) {
      throw toUnavailable(err);
    }

    if (message.stop_reason === 'refusal') {
      throw new LlmUnavailableError('Claude declined this request.', 'refusal');
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!text.trim()) {
      throw new LlmUnavailableError(
        `Claude returned no text (stop_reason ${message.stop_reason ?? 'unknown'}).`,
        'bad-response',
      );
    }

    console.log(
      `[llm] ${request.model} ${Date.now() - started}ms ` +
        `in=${message.usage.input_tokens} out=${message.usage.output_tokens} stop=${message.stop_reason ?? '?'}`,
    );

    return {
      text,
      stopReason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}
