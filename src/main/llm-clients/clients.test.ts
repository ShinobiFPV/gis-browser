import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../harvester/http';
import { LlmUnavailableError, excerptProviderError } from '../llm-types';
import { GeminiClient, toGeminiSchema } from './gemini';
import { OpenAiCompatibleClient, statusToUnavailable } from './openai';
import { modelInfo, providerInfo, LLM_PROVIDERS } from '@shared/llm-providers';
import { PARSE_JSON_SCHEMA } from '@resolve/llm-contract';

/**
 * The non-SDK clients, exercised without a network.
 *
 * What matters here is not that a happy path parses -- it is that every failure becomes an
 * LlmUnavailableError so the caller falls back to the local resolver, and that credentials
 * go in headers rather than URLs.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({ fetchImpl, sleepImpl: () => Promise.resolve(), maxAttempts: 1 });
}

/** Answers with a fixed status and body, recording what was sent. */
function fakeHttp(
  reply: { status: number; body: unknown },
  captured: Captured[] = [],
): { http: HttpClient; captured: Captured[] } {
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    captured.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(raw) as unknown,
    });
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: new Headers(),
      text: () => Promise.resolve(text),
    } as unknown as Response);
  }) as unknown as typeof fetch;

  return { http: client(fetchImpl), captured };
}

/** Fails at the transport layer, the way an unreachable local runtime does. */
function unreachableHttp(message: string): HttpClient {
  return client(() => Promise.reject(new Error(message)));
}

const REQUEST = {
  model: 'test-model',
  system: 'you are a parser',
  user: 'Parry Island First Nation',
  maxTokens: 1024,
  timeoutMs: 5000,
};

describe('OpenAI-compatible client', () => {
  it('returns the assistant text and token counts', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: {
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      },
    });
    const client = new OpenAiCompatibleClient(http, 'https://api.example.test/v1', () => 'sk-x', true, 'Test');
    const res = await client.send(REQUEST);

    expect(res.text).toBe('{"ok":true}');
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(7);
  });

  it('sends the key as a bearer header and never in the URL', async () => {
    // The HTTP client logs every URL. A credential in the query string would be written
    // into a log file permanently.
    const { http, captured } = fakeHttp({
      status: 200,
      body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] },
    });
    await new OpenAiCompatibleClient(http, 'https://api.example.test/v1', () => 'sk-secret', true, 'Test').send(
      REQUEST,
    );

    expect(captured[0]!.headers['Authorization']).toBe('Bearer sk-secret');
    expect(captured[0]!.url).not.toContain('sk-secret');
    expect(captured[0]!.url).toBe('https://api.example.test/v1/chat/completions');
  });

  it('maps the system prompt to a system message', async () => {
    const { http, captured } = fakeHttp({
      status: 200,
      body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] },
    });
    await new OpenAiCompatibleClient(http, 'https://x/v1', () => 'k', true, 'Test').send(REQUEST);

    const body = captured[0]!.body as { messages: { role: string; content: string }[] };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are a parser' });
    expect(body.messages[1]!.role).toBe('user');
  });

  it('sends a strict json_schema response format when a schema is supplied', async () => {
    const { http, captured } = fakeHttp({
      status: 200,
      body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] },
    });
    await new OpenAiCompatibleClient(http, 'https://x/v1', () => 'k', true, 'Test').send({
      ...REQUEST,
      jsonSchema: PARSE_JSON_SCHEMA,
      effort: 'low',
    });

    const body = captured[0]!.body as Record<string, unknown>;
    const rf = body['response_format'] as { type: string; json_schema: { strict: boolean } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(body['reasoning_effort']).toBe('low');
  });

  it('does not require a key when the provider says one is optional', async () => {
    // A local Ollama needs no credential. Demanding one would make the whole
    // openai-compatible option unusable for the case it exists for.
    const { http, captured } = fakeHttp({
      status: 200,
      body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] },
    });
    await new OpenAiCompatibleClient(http, 'http://localhost:11434/v1', () => null, false, 'Ollama').send(REQUEST);
    expect(captured[0]!.headers['Authorization']).toBeUndefined();
  });

  it('raises no-key when the provider does require one', async () => {
    const { http } = fakeHttp({ status: 200, body: {} });
    await expect(
      new OpenAiCompatibleClient(http, 'https://x/v1', () => null, true, 'Test').send(REQUEST),
    ).rejects.toThrow(/No Test API key/);
  });

  it('turns an unreachable endpoint into a network failure, not a crash', async () => {
    const http = unreachableHttp('ECONNREFUSED');
    const err = await new OpenAiCompatibleClient(http, 'http://localhost:11434/v1', () => null, false, 'Ollama')
      .send(REQUEST)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).reason).toBe('network');
  });

  it('treats an empty completion as a bad response', async () => {
    const { http } = fakeHttp({ status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } });
    await expect(
      new OpenAiCompatibleClient(http, 'https://x/v1', () => 'k', true, 'Test').send(REQUEST),
    ).rejects.toThrow(/returned no text/);
  });

  it('reports a content filter as a refusal', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
    });
    const err = await new OpenAiCompatibleClient(http, 'https://x/v1', () => 'k', true, 'Test')
      .send(REQUEST)
      .catch((e: unknown) => e);
    expect((err as LlmUnavailableError).reason).toBe('refusal');
  });
});

describe('Gemini client', () => {
  it('puts the key in a header, never the query string', async () => {
    // Google's own examples use ?key=…, which would land in every log line.
    const { http, captured } = fakeHttp({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] },
    });
    await new GeminiClient(http, 'https://gen.example.test/v1beta', () => 'AIza-secret').send(REQUEST);

    expect(captured[0]!.headers['x-goog-api-key']).toBe('AIza-secret');
    expect(captured[0]!.url).not.toContain('AIza-secret');
    expect(captured[0]!.url).toContain('/models/test-model:generateContent');
  });

  it('uses systemInstruction and contents rather than messages', async () => {
    const { http, captured } = fakeHttp({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] },
    });
    await new GeminiClient(http, 'https://x/v1beta', () => 'k').send(REQUEST);

    const body = captured[0]!.body as Record<string, unknown>;
    expect(JSON.stringify(body['systemInstruction'])).toContain('you are a parser');
    expect(JSON.stringify(body['contents'])).toContain('Parry Island');
  });

  it('joins multi-part responses', async () => {
    const { http } = fakeHttp({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: '{"a"' }, { text: ':1}' }] }, finishReason: 'STOP' }] },
    });
    const res = await new GeminiClient(http, 'https://x/v1beta', () => 'k').send(REQUEST);
    expect(res.text).toBe('{"a":1}');
  });

  it('reports a safety block as a refusal', async () => {
    const { http } = fakeHttp({ status: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } });
    const err = await new GeminiClient(http, 'https://x/v1beta', () => 'k')
      .send(REQUEST)
      .catch((e: unknown) => e);
    expect((err as LlmUnavailableError).reason).toBe('refusal');
  });
});

describe('toGeminiSchema', () => {
  it('strips additionalProperties, which Gemini rejects outright', () => {
    // Our contract schemas set it everywhere. Sending them verbatim is a 400 that looks
    // like a broken provider rather than a schema quibble.
    const out = JSON.stringify(toGeminiSchema(PARSE_JSON_SCHEMA));
    expect(out).not.toContain('additionalProperties');
    expect(out).toContain('place_names');
  });

  it('collapses a type union into a type plus nullable', () => {
    const out = toGeminiSchema({ type: ['string', 'null'] }) as Record<string, unknown>;
    expect(out['type']).toBe('string');
    expect(out['nullable']).toBe(true);
  });

  it('leaves an ordinary schema alone', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(toGeminiSchema(schema)).toEqual(schema);
  });
});

describe('status mapping', () => {
  it('maps HTTP status onto the reason the resolver acts on', () => {
    expect(statusToUnavailable(401, '{}', 'X').reason).toBe('auth');
    expect(statusToUnavailable(403, '{}', 'X').reason).toBe('auth');
    expect(statusToUnavailable(429, '{}', 'X').reason).toBe('rate-limit');
    expect(statusToUnavailable(500, '{}', 'X').reason).toBe('api');
  });

  it('says what a 404 usually means, because a hand-typed model id is the common cause', () => {
    expect(statusToUnavailable(404, '{}', 'X').message).toMatch(/model id or base URL/);
  });

  it('pulls the readable message out of a provider error body', () => {
    expect(excerptProviderError('{"error":{"message":"Incorrect API key provided"}}')).toBe(
      'Incorrect API key provided',
    );
    expect(excerptProviderError('{"error":"flat string"}')).toBe('flat string');
    expect(excerptProviderError('not json at all')).toBe('not json at all');
  });
});

describe('provider catalog', () => {
  it('gives every provider a protocol a client exists for', () => {
    for (const p of LLM_PROVIDERS) {
      expect(['anthropic', 'openai', 'gemini']).toContain(p.protocol);
    }
  });

  it('only lets the base URL be edited where that is the point', () => {
    expect(providerInfo('openai-compatible').baseUrlEditable).toBe(true);
    expect(providerInfo('anthropic').baseUrlEditable).toBe(false);
    expect(providerInfo('openai').baseUrlEditable).toBe(false);
  });

  it('assumes nothing about a model it does not know', () => {
    // Guessing capabilities upward means sending parameters the endpoint rejects, turning
    // a working setup into a hard 400.
    const unknown = modelInfo('openai-compatible', 'llama3.1:8b');
    expect(unknown.structuredOutputs).toBe(false);
    expect(unknown.effort).toBe(false);
    expect(unknown.adaptiveThinking).toBe(false);
    expect(unknown.label).toBe('llama3.1:8b');
  });

  it('still knows the models it ships with', () => {
    expect(modelInfo('anthropic', 'claude-sonnet-5').structuredOutputs).toBe(true);
    expect(modelInfo('anthropic', 'claude-sonnet-4-6').structuredOutputs).toBe(false);
    expect(modelInfo('anthropic', 'claude-haiku-4-5').effort).toBe(false);
  });

  it('falls back to a real provider rather than throwing on a bad id', () => {
    expect(providerInfo('nonsense').id).toBe('anthropic');
  });
});
