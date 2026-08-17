import Anthropic from '@anthropic-ai/sdk';
import {
  LlmUnavailableError,
  type MessageClient,
  type MessageRequest,
  type MessageResult,
} from '../llm-types';

/**
 * Claude, through the official Anthropic SDK.
 *
 * The one provider that does not go through the shared HTTP client. It was here first,
 * the SDK gives typed error classes that map cleanly onto our fallback reasons, and
 * swapping it for hand-rolled HTTP to gain symmetry would be a downgrade.
 *
 * The key is read per request and the client is constructed per request, so a key change
 * takes effect immediately and no key is held in a long-lived object. The log line
 * carries model and timing only.
 */
export class AnthropicClient implements MessageClient {
  constructor(private readonly getKey: () => string | null) {}

  async send(request: MessageRequest): Promise<MessageResult> {
    const apiKey = this.getKey();
    if (!apiKey) {
      throw new LlmUnavailableError('No Anthropic API key is stored. Add one in Settings.', 'no-key');
    }

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
      `[llm] anthropic ${request.model} ${Date.now() - started}ms ` +
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

/** Maps the SDK's typed errors onto the fallback reasons the resolver understands. */
function toUnavailable(err: unknown): LlmUnavailableError {
  if (err instanceof LlmUnavailableError) return err;

  // Most specific first, as the SDK's class hierarchy is designed for.
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
