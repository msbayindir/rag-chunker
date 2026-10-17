import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveConfig } from '../../src/config/load.js'
import type { RagChunkerConfig } from '../../src/config/schema.js'
import { RagChunkerError } from '../../src/errors.js'
import { requestJson } from '../../src/providers/http.js'
import { extractJson, jsonSchemaOf } from '../../src/providers/json.js'
import { mistralOcr } from '../../src/providers/mistral-ocr.js'
import {
  createEmbedder,
  createLLM,
  type ProviderContext,
  parseModelRef,
} from '../../src/providers/registry.js'
import { isRetryable, retryAfterMs, withRetry } from '../../src/providers/retry.js'
import { generateJson } from '../../src/providers/structured.js'
import { anthropicStream, json, MockServer, openaiChat, sse } from '../helpers/mock-server.js'

const server = new MockServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

function ctx(providers: RagChunkerConfig['providers'], env: Record<string, string> = {}): ProviderContext {
  return { config: resolveConfig({ providers }), env }
}

const schema = z.strictObject({ items: z.array(z.strictObject({ id: z.number(), summary: z.string() })) })

describe('registry', () => {
  it('parses provider/model references, keeping slashes in the model', () => {
    expect(parseModelRef('openrouter/anthropic/claude-haiku-5-5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5-5',
    })
    expect(() => parseModelRef('gemma4')).toThrow(RagChunkerError)
  })

  it('reports unknown providers and missing keys with hints', () => {
    expect(() => createLLM('nope/x', ctx({}))).toThrow(/Unknown provider/)
    try {
      createLLM('openai/gpt-x', ctx({}))
      expect.unreachable()
    } catch (err) {
      expect((err as RagChunkerError).code).toBe('MISSING_API_KEY')
      expect((err as RagChunkerError).hint).toContain('OPENAI_API_KEY')
    }
    expect(() => createEmbedder('anthropic/claude-haiku-5-5', ctx({}, { ANTHROPIC_API_KEY: 'k' }))).toThrow(
      /embeddings/,
    )
  })

  it('does not require keys for local providers', () => {
    expect(createLLM('ollama/gemma4:e4b-it-qat', ctx({})).ref).toBe('ollama/gemma4:e4b-it-qat')
    expect(createLLM('lmstudio/qwen', ctx({})).provider.local).toBe(true)
  })
})

describe('openai-compatible adapter', () => {
  const providers = () => ({ lab: { type: 'openai-compatible' as const, baseURL: `${server.url}/v1` } })

  it('sends json_schema structured output, the prefix first and images as data URLs', async () => {
    server.on('POST', '/v1/chat/completions', (_r, res) =>
      json(res, 200, openaiChat('{"items":[{"id":1,"summary":"özet"}]}')),
    )
    const llm = createLLM('lab/test-model', ctx(providers()))
    const out = await generateJson(
      llm,
      {
        system: 'sys',
        prefix: 'DOCUMENT',
        parts: [
          { type: 'text', text: 'chunk' },
          { type: 'image', data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
        ],
      },
      schema,
      'summaries',
    )
    expect(out.value.items[0]?.summary).toBe('özet')
    expect(out.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 8, requests: 1 })
    const body = server.requests[0]?.body as Record<string, any>
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.max_tokens).toBe(4096)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'DOCUMENT' })
    expect(body.messages[1].content[2].image_url.url).toBe('data:image/png;base64,AQID')
  })

  it('falls back to json_object, then plain prompting, when the server rejects response_format', async () => {
    server.on('POST', '/v1/chat/completions', (r, res) => {
      const fmt = (r.body as any).response_format
      if (fmt?.type === 'json_schema')
        return json(res, 400, { error: { message: 'response_format json_schema unsupported' } })
      if (fmt?.type === 'json_object')
        return json(res, 400, { error: { message: 'response_format not supported' } })
      return json(res, 200, openaiChat('Sure: ```json\n{"items":[]}\n```'))
    })
    const llm = createLLM('lab/m', ctx(providers()))
    const out = await generateJson(llm, { parts: [{ type: 'text', text: 'x' }] }, schema, 's')
    expect(out.value.items).toEqual([])
    expect(server.requests).toHaveLength(3)
    const last = server.requests[2]?.body as any
    expect(last.response_format).toBeUndefined()
    expect(last.messages[0].content).toContain('JSON Schema')
    // The adapter remembers the working mode.
    await generateJson(llm, { parts: [{ type: 'text', text: 'y' }] }, schema, 's')
    expect(server.requests).toHaveLength(4)
  })

  it('retries 429 responses (honouring Retry-After) and maps 401 to MISSING_API_KEY', async () => {
    server.on(
      'POST',
      '/v1/chat/completions',
      (_r, res) => json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' }),
      1,
    )
    server.on('POST', '/v1/chat/completions', (_r, res) => json(res, 200, openaiChat('ok')))
    const llm = createLLM('lab/m', ctx(providers()))
    expect((await llm.generate({ parts: [{ type: 'text', text: 'hi' }] })).text).toBe('ok')
    expect(server.requests).toHaveLength(2)

    server.reset()
    server.on('POST', '/v1/chat/completions', (_r, res) => json(res, 401, { error: { message: 'bad key' } }))
    await expect(llm.generate({ parts: [{ type: 'text', text: 'hi' }] })).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    })
  }, 20_000)

  it('marks the prefix cacheable for Anthropic models on OpenRouter', async () => {
    server.on('POST', '/v1/chat/completions', (_r, res) => json(res, 200, openaiChat('ok')))
    const c = ctx({ openrouter: { baseURL: `${server.url}/v1` } }, { OPENROUTER_API_KEY: 'k' })
    await createLLM('openrouter/anthropic/claude-haiku-5-5', c).generate({
      prefix: 'DOC',
      parts: [{ type: 'text', text: 'q' }],
    })
    const r = server.requests[0]
    const body = r?.body as any
    expect(body.model).toBe('anthropic/claude-haiku-5-5')
    expect(body.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'DOC',
      cache_control: { type: 'ephemeral' },
    })
    expect(r?.headers.authorization).toBe('Bearer k')
    expect(r?.headers['x-title']).toBe('rag-chunker')
  })

  it('embeds in input order and passes dimensions', async () => {
    server.on('POST', '/v1/embeddings', (_r, res) =>
      json(res, 200, {
        object: 'list',
        data: [
          { object: 'embedding', index: 1, embedding: [0, 1] },
          { object: 'embedding', index: 0, embedding: [1, 0] },
        ],
        model: 'e',
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    )
    const c: ProviderContext = {
      config: resolveConfig({ providers: providers(), embedding: { dimensions: 2 } }),
      env: {},
    }
    const e = createEmbedder('lab/text-embedding-3-small', c)
    const out = await e.embed(['a', 'b'], 'document')
    expect(out.vectors).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect((server.requests[0]?.body as any).dimensions).toBe(2)
    expect(await e.maxInputTokens()).toBe(8191)
  })
})

describe('anthropic adapter', () => {
  const c = () => ctx({ anthropic: { baseURL: server.url } }, { ANTHROPIC_API_KEY: 'sk-ant' })

  it('caches the prefix in the system prompt and requests structured output', async () => {
    server.on('POST', '/v1/messages', (_r, res) =>
      sse(res, anthropicStream('{"items":[{"id":3,"summary":"x"}]}')),
    )
    const llm = createLLM('anthropic/claude-haiku-5-5', c())
    const out = await generateJson(
      llm,
      { system: 'rules', prefix: 'THE DOCUMENT', parts: [{ type: 'text', text: 'chunks' }], effort: 'low' },
      schema,
      'summaries',
    )
    expect(out.value.items[0]?.id).toBe(3)
    expect(out.usage.cachedInputTokens).toBe(100)
    const r = server.requests[0]
    const body = r?.body as any
    expect(r?.headers['x-api-key']).toBe('sk-ant')
    expect(body.system).toEqual([
      { type: 'text', text: 'rules' },
      { type: 'text', text: 'THE DOCUMENT', cache_control: { type: 'ephemeral' } },
    ])
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.output_config.effort).toBe('low')
    expect(body.temperature).toBeUndefined()
    expect(body.stream).toBe(true)
  })

  it('turns a refusal into an error', async () => {
    server.on('POST', '/v1/messages', (_r, res) => sse(res, anthropicStream('', { stopReason: 'refusal' })))
    await expect(
      createLLM('anthropic/claude-haiku-5-5', c()).generate({ parts: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/declined/)
  })

  it('reads the context window from the Models API', async () => {
    server.on('GET', '/v1/models/claude-haiku-5-5', (_r, res) =>
      json(res, 200, {
        id: 'claude-haiku-5-5',
        type: 'model',
        max_input_tokens: 1_000_000,
        max_tokens: 64_000,
      }),
    )
    const caps = await createLLM('anthropic/claude-haiku-5-5', c()).capabilities()
    expect(caps).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000, vision: true })
  })
})

describe('gemini adapter', () => {
  const c = () => ctx({ gemini: { baseURL: server.url } }, { GEMINI_API_KEY: 'g-key' })
  const reply = (text: string) => ({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6, cachedContentTokenCount: 25 },
  })

  it('uses responseJsonSchema and an explicit cache for large prefixes', async () => {
    server.on('POST', '/cachedContents', (_r, res) => json(res, 200, { name: 'cachedContents/abc' }))
    server.on('POST', ':generateContent', (_r, res) => json(res, 200, reply('{"items":[]}')))
    server.on('DELETE', 'cachedContents/abc', (_r, res) => json(res, 200, {}))
    const llm = createLLM('gemini/gemini-3.8-flash', c())
    const prefix = 'belge '.repeat(4000)
    const out = await generateJson(
      llm,
      { system: 'sys', prefix, parts: [{ type: 'text', text: 'q' }], effort: 'low' },
      schema,
      's',
    )
    expect(out.value.items).toEqual([])
    const cacheReq = server.requests.find((r) => r.path.includes('/cachedContents') && r.method === 'POST')
    expect(JSON.stringify(cacheReq?.body)).toContain('belge')
    const gen = server.requests.find((r) => r.path.includes(':generateContent'))
    const body = gen?.body as any
    expect(body.cachedContent).toBe('cachedContents/abc')
    expect(body.generationConfig.responseJsonSchema).toBeDefined()
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW')
    expect(JSON.stringify(body.contents)).not.toContain('belge belge')
    await llm.dispose()
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(true)
  })

  it('sends the prefix inline when cache creation fails', async () => {
    server.on('POST', '/cachedContents', (_r, res) =>
      json(res, 400, { error: { code: 400, message: 'too small', status: 'INVALID_ARGUMENT' } }),
    )
    server.on('POST', ':generateContent', (_r, res) => json(res, 200, reply('hello')))
    const llm = createLLM('gemini/gemini-3.8-flash', c())
    const res = await llm.generate({
      system: 'sys',
      prefix: 'x'.repeat(20_000),
      parts: [{ type: 'text', text: 'q' }],
    })
    expect(res.text).toBe('hello')
    const gen = server.requests.find((r) => r.path.includes(':generateContent'))?.body as any
    expect(gen.cachedContent).toBeUndefined()
    expect(gen.systemInstruction).toBeDefined()
    expect(JSON.stringify(gen.contents)).toContain('xxxx')
  })

  it('batches embeddings with task types and normalises vectors', async () => {
    server.on('POST', ':batchEmbedContents', (_r, res) =>
      json(res, 200, { embeddings: [{ values: [3, 4] }, { values: [0, 2] }] }),
    )
    const e = createEmbedder('gemini/gemini-embedding-001', c())
    const out = await e.embed(['a', 'b'], 'query')
    expect(out.vectors).toEqual([
      [0.6, 0.8],
      [0, 1],
    ])
    expect(JSON.stringify(server.requests[0]?.body)).toContain('RETRIEVAL_QUERY')
  })
})

describe('ollama adapter', () => {
  const c = () => ctx({ ollama: { baseURL: server.url, maxContext: 16384 } })
  const show = (capabilities: string[], ctxLen = 131072) => ({
    model_info: { 'gemma4.context_length': ctxLen, 'gemma4.embedding_length': 768 },
    capabilities,
  })

  it('sends a JSON schema format, think=false, a sticky num_ctx and base64 images', async () => {
    server.on('POST', '/api/show', (_r, res) => json(res, 200, show(['completion', 'vision', 'thinking'])))
    server.on('POST', '/api/chat', (_r, res) =>
      json(res, 200, {
        model: 'g',
        message: { role: 'assistant', content: '{"items":[]}' },
        done: true,
        prompt_eval_count: 50,
        eval_count: 4,
      }),
    )
    const llm = createLLM('ollama/gemma4:e4b-it-qat', c())
    expect(await llm.capabilities()).toEqual({ contextWindow: 16384, maxOutputTokens: 8192, vision: true })
    await generateJson(
      llm,
      {
        system: 's',
        prefix: 'P'.repeat(9000),
        parts: [{ type: 'image', data: new Uint8Array([255]), mimeType: 'image/png' }],
      },
      schema,
      's',
    )
    await llm.generate({ parts: [{ type: 'text', text: 'small' }] })
    const chats = server.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as any)
    expect(chats[0].format.type).toBe('object')
    expect(chats[0].think).toBe(false)
    expect(chats[0].messages[1].images).toEqual(['/w=='])
    expect(chats[0].options.num_ctx).toBeGreaterThanOrEqual(8192)
    expect(chats[0].options.num_ctx % 2048).toBe(0)
    // num_ctx never shrinks (changing it reloads the model).
    expect(chats[1].options.num_ctx).toBe(chats[0].options.num_ctx)
  })

  it('reports a missing model with an ollama pull hint', async () => {
    server.on('POST', '/api/show', (_r, res) => json(res, 404, { error: "model 'nope' not found" }))
    const err = await createLLM('ollama/nope', c())
      .generate({ parts: [{ type: 'text', text: 'x' }] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(RagChunkerError)
    expect(err.code).toBe('MODEL_NOT_FOUND')
    expect(err.hint).toBe('Run: ollama pull nope')
  })

  it('adds EmbeddingGemma task prefixes and refuses chat models for embeddings', async () => {
    server.on('POST', '/api/show', (r, res) =>
      json(
        res,
        200,
        (r.body as any).model === 'embeddinggemma' ? show(['embedding'], 2048) : show(['completion']),
      ),
    )
    server.on('POST', '/api/embed', (_r, res) =>
      json(res, 200, { embeddings: [[0.1], [0.2]], prompt_eval_count: 7 }),
    )
    const e = createEmbedder('ollama/embeddinggemma', c())
    expect(await e.maxInputTokens()).toBe(2032)
    await e.embed(['belge', 'soru'], 'document')
    const body = server.requests.find((r) => r.path === '/api/embed')?.body as any
    expect(body.input).toEqual(['title: none | text: belge', 'title: none | text: soru'])
    await expect(createEmbedder('ollama/gemma4:e4b-it-qat', c()).maxInputTokens()).rejects.toMatchObject({
      code: 'CAPABILITY_MISSING',
    })
  })
})

describe('mistral OCR', () => {
  it('posts the document as a data URL with header/footer extraction and selected pages', async () => {
    server.on('POST', '/v1/ocr', (_r, res) =>
      json(res, 200, {
        model: 'mistral-ocr-2512',
        pages: [{ index: 0, markdown: '# Başlık' }],
        usage_info: { pages_processed: 1 },
      }),
    )
    const c = ctx({ mistral: { baseURL: `${server.url}/v1` } }, { MISTRAL_API_KEY: 'm-key' })
    const provider = (await import('../../src/providers/registry.js')).getProvider('mistral', c)
    const out = await mistralOcr({
      provider,
      bytes: new Uint8Array([37, 80, 68, 70]),
      mime: 'application/pdf',
      kind: 'pdf',
      pages: [0],
    })
    expect(out.pages[0]?.markdown).toBe('# Başlık')
    const r = server.requests[0]
    const body = r?.body as any
    expect(r?.headers.authorization).toBe('Bearer m-key')
    expect(body.document.document_url).toBe('data:application/pdf;base64,JVBERg==')
    expect(body).toMatchObject({
      extract_header: true,
      extract_footer: true,
      include_image_base64: false,
      pages: [0],
    })
  })
})

describe('retry and JSON helpers', () => {
  it('retries transient HTTP errors and gives up on client errors', async () => {
    let calls = 0
    server.on('GET', '/flaky', (_r, res) => {
      calls++
      if (calls < 2) json(res, 503, { error: 'busy' }, { 'retry-after': '0' })
      else json(res, 200, { ok: true })
    })
    expect(await requestJson(`${server.url}/flaky`, { timeoutMs: 5000, maxRetries: 3 })).toEqual({ ok: true })
    server.on('GET', '/bad', (_r, res) => json(res, 400, { message: 'bad input' }))
    await expect(requestJson(`${server.url}/bad`, { timeoutMs: 5000, maxRetries: 3 })).rejects.toThrow(
      'bad input',
    )
    expect(server.requests.filter((r) => r.path === '/bad')).toHaveLength(1)
  }, 15_000)

  it('times out slow requests', async () => {
    server.on('GET', '/slow', () => new Promise(() => {}))
    await expect(requestJson(`${server.url}/slow`, { timeoutMs: 200, maxRetries: 0 })).rejects.toThrow()
  })

  it('classifies errors and reads Retry-After', () => {
    expect(isRetryable({ status: 429 })).toBe(true)
    expect(isRetryable({ status: 400 })).toBe(false)
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '2' }) })).toBe(2000)
    expect(retryAfterMs({ headers: { 'retry-after-ms': '150' } })).toBe(150)
  })

  it('withRetry stops when aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(withRetry(async () => 1, { maxRetries: 2, signal: ctrl.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    })
  })

  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('Here you go: {"a":[1,2]} thanks')).toBe('{"a":[1,2]}')
    expect(extractJson('[1,2]')).toBe('[1,2]')
  })

  it('produces strict JSON schemas', () => {
    const s = jsonSchemaOf(schema) as any
    expect(s.$schema).toBeUndefined()
    expect(s.additionalProperties).toBe(false)
    expect(s.properties.items.items.required).toEqual(['id', 'summary'])
  })

  it('generateJson retries invalid output once, then fails clearly', async () => {
    let n = 0
    server.on('POST', '/v1/chat/completions', (_r, res) => {
      n++
      json(res, 200, openaiChat(n === 1 ? 'not json' : '{"items":[{"id":1,"summary":"ok"}]}'))
    })
    const llm = createLLM('lab/m', ctx({ lab: { type: 'openai-compatible', baseURL: `${server.url}/v1` } }))
    const out = await generateJson(llm, { parts: [{ type: 'text', text: 'x' }] }, schema, 's')
    expect(out.value.items).toHaveLength(1)
    expect(out.usage.requests).toBe(2)
    const second = server.requests[1]?.body as any
    expect(JSON.stringify(second.messages)).toContain('previous answer was not valid')

    server.reset()
    server.on('POST', '/v1/chat/completions', (_r, res) => json(res, 200, openaiChat('{"wrong":true}')))
    await expect(
      generateJson(llm, { parts: [{ type: 'text', text: 'x' }] }, schema, 's'),
    ).rejects.toMatchObject({
      code: 'STRUCTURED_OUTPUT_FAILED',
    })
  })
})
