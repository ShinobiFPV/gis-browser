/**
 * The LLM providers the app can talk to.
 *
 * The LLM is an enhancement to search, never a dependency: it parses the request and
 * re-ranks candidates, and every failure falls back to the local resolver. That is what
 * makes swapping providers safe to offer at all -- the worst case of a misconfigured
 * provider is the search everyone was getting before, not a broken app.
 *
 * Three wire protocols cover essentially everything:
 *
 *   anthropic  Claude, via the official SDK.
 *   openai     /chat/completions. OpenAI itself, and every service that copied it --
 *              OpenRouter, Groq, Together, DeepSeek, xAI, Ollama, LM Studio, vLLM.
 *   gemini     Google's generateContent, which is its own shape.
 *
 * So "openai-compatible with a base URL you choose" is not a fourth-class option, it is
 * the one that covers local models and every aggregator without this file needing to
 * know they exist.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

/** Which request/response shape the client speaks. */
export type ProviderProtocol = 'anthropic' | 'openai' | 'gemini';

export interface LlmModel {
  id: string;
  label: string;
  /**
   * Whether the response can be constrained to a JSON Schema by the API. When it can, a
   * malformed reply becomes impossible rather than merely unlikely. Every reply is
   * validated afterwards regardless, so this changes how often the fallback fires, not
   * whether bad data can get through.
   */
  structuredOutputs: boolean;
  /** Accepts a reasoning-effort setting. */
  effort: boolean;
  /** Accepts Anthropic's adaptive thinking. Meaningless elsewhere. */
  adaptiveThinking: boolean;
  note?: string;
}

export interface LlmProvider {
  id: ProviderId;
  label: string;
  protocol: ProviderProtocol;
  /** Where requests go. Editable only where the whole point is pointing it somewhere. */
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  /** Some local runtimes need no key at all. */
  keyRequired: boolean;
  keyHint: string;
  /** Where to get a key, shown in the UI. */
  keyUrl: string | null;
  /** A starting list. Any provider also accepts a model id typed in by hand. */
  models: LlmModel[];
  note: string;
}

/** Anthropic's own capability table, unchanged from when Claude was the only option. */
const CLAUDE_MODELS: LlmModel[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    structuredOutputs: false,
    effort: true,
    adaptiveThinking: true,
    note: 'Named in the original project brief. JSON is requested by prompt and validated, not schema-enforced.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: true,
    note: 'Recommended. Same tier as the brief’s model, but the parse cannot come back malformed.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: true,
    note: 'Strongest ranking judgement, highest cost.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
    note: 'Cheapest and fastest. Does not accept effort or adaptive thinking.',
  },
];

const OPENAI_MODELS: LlmModel[] = [
  {
    id: 'gpt-5',
    label: 'GPT-5',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: false,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    structuredOutputs: true,
    effort: true,
    adaptiveThinking: false,
    note: 'Cheaper; ample for parsing a place name.',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
  },
];

const GEMINI_MODELS: LlmModel[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    structuredOutputs: true,
    effort: false,
    adaptiveThinking: false,
    note: 'Fast and cheap. Fine for both passes.',
  },
];

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlEditable: false,
    keyRequired: true,
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: CLAUDE_MODELS,
    note: 'Uses the official Anthropic SDK. The app was built and tested against this one.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: false,
    keyRequired: true,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: OPENAI_MODELS,
    note: 'Chat completions with a JSON Schema response format.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: false,
    keyRequired: true,
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: GEMINI_MODELS,
    note: 'The key travels in a header, never in the URL, so it cannot end up in a log line.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    protocol: 'openai',
    // Ollama's default. Anything speaking /chat/completions works: LM Studio on 1234,
    // OpenRouter, Groq, Together, DeepSeek, xAI, a vLLM box on your own network.
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    keyRequired: false,
    keyHint: 'often blank for a local model',
    keyUrl: null,
    models: [],
    note:
      'Point this at any service that speaks the OpenAI chat-completions API — Ollama, ' +
      'LM Studio, vLLM, OpenRouter, Groq, Together, DeepSeek, xAI. Type the model id yourself.',
  },
];

export const DEFAULT_PROVIDER: ProviderId = 'anthropic';
export const DEFAULT_MODEL = CLAUDE_MODELS[0]!.id;

export function providerInfo(id: string): LlmProvider {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? LLM_PROVIDERS[0]!;
}

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && LLM_PROVIDERS.some((p) => p.id === v);
}

/**
 * Capabilities for a model id under a provider.
 *
 * A model typed in by hand is unknown to this table, so it gets the cautious answer:
 * no schema enforcement, no effort, no thinking. Everything still works -- JSON is
 * requested by prompt and validated afterwards -- it just leans on the fallback more.
 * Guessing capabilities upward would mean sending parameters the endpoint rejects,
 * turning a working setup into a hard 400.
 */
export function modelInfo(providerId: string, modelId: string): LlmModel {
  const known = providerInfo(providerId).models.find((m) => m.id === modelId);
  if (known) return known;
  return {
    id: modelId,
    label: modelId,
    structuredOutputs: false,
    effort: false,
    adaptiveThinking: false,
    note: 'Not in the built-in list, so no optional parameters are sent and the reply is validated after the fact.',
  };
}
