import { providerInfo } from '@shared/llm-providers';
import { HttpClient } from '../../harvester/http';
import { readKey } from '../keychain';
import type { MessageClient } from '../llm-types';
import { AnthropicClient } from './anthropic';
import { GeminiClient } from './gemini';
import { OpenAiCompatibleClient } from './openai';

/**
 * Builds the client for whichever provider is currently selected.
 *
 * Constructed per search rather than held, so changing provider, model, base URL or key
 * in Settings takes effect on the next search with no restart and no cache to invalidate.
 * The key is read lazily inside the client, at the moment a request is built, so it is
 * never captured in a long-lived closure.
 */

/**
 * One HTTP client for every LLM call, sharing the retry and concurrency rules.
 *
 * Two attempts, not four: this is an interactive path with someone waiting, and the
 * caller falls back to the local resolver anyway. Making an artist on deadline wait
 * through four backoffs before the fallback fires would be the wrong trade.
 */
const http = new HttpClient({
  maxAttempts: 2,
  timeoutMs: 60_000,
  log: (level, message) => {
    if (level === 'warn' || level === 'error') console.warn(`[llm] ${message}`);
  },
});

export interface LlmConfig {
  providerId: string;
  /** Only meaningful for providers whose base URL is editable. */
  baseUrl?: string;
}

export function createClient(config: LlmConfig): MessageClient {
  const provider = providerInfo(config.providerId);
  const getKey = (): string | null => readKey(provider.id);

  const baseUrl =
    provider.baseUrlEditable && config.baseUrl?.trim() ? config.baseUrl.trim() : provider.defaultBaseUrl;

  switch (provider.protocol) {
    case 'anthropic':
      return new AnthropicClient(getKey);
    case 'gemini':
      return new GeminiClient(http, baseUrl, getKey);
    case 'openai':
      return new OpenAiCompatibleClient(http, baseUrl, getKey, provider.keyRequired, provider.label);
  }
}

export { AnthropicClient, GeminiClient, OpenAiCompatibleClient };
