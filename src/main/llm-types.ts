/**
 * The contract every LLM client implements.
 *
 * Deliberately the smallest surface that serves both passes: one system prompt, one user
 * message, a token ceiling, a timeout, and three optional capabilities. Anything a
 * specific provider needs beyond that is the client's business, not the caller's --
 * llm.ts has no idea which provider answered.
 */

export type LlmFailureReason =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'refusal'
  | 'bad-response'
  | 'api'
  | 'not-configured';

/** Raised for anything that should make the caller fall back to the local resolver. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: LlmFailureReason,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
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

/**
 * Injectable so the calling logic can be tested without a network, a key, or any SDK.
 */
export interface MessageClient {
  send(request: MessageRequest): Promise<MessageResult>;
}

/**
 * Pulls the readable part out of an error body without ever echoing a request.
 *
 * Provider error payloads are small and safe; request bodies are not, because the user's
 * prompt is in them. Only the former is ever surfaced.
 */
export function excerptProviderError(body: string, limit = 300): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const err = parsed.error;
    const message =
      typeof err === 'string' ? err : (err?.message ?? parsed.message ?? null);
    if (message) return message.slice(0, limit);
  } catch {
    // Not JSON. Fall through to the raw text.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, limit);
}
