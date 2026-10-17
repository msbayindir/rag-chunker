import type OpenAI from 'openai'
import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import { importOptional } from '../util/optional.js'
import { timeoutSignal, toProviderError, withRetry } from './retry.js'
import {
  type Embedder,
  type EmbeddingKind,
  emptyUsage,
  type GenerateRequest,
  type GenerateResult,
  type LLM,
  type ModelCapabilities,
  toBase64,
  type Usage,
} from './types.js'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart

async function createClient(provider: ResolvedProvider): Promise<OpenAI> {
  const mod = await importOptional('openai', `The "${provider.name}" provider`, () => import('openai'))
  const OpenAIClass = mod.default
  return new OpenAIClass({
    apiKey: provider.apiKey ?? 'not-needed',
    baseURL: provider.baseURL,
    defaultHeaders: {
      ...(provider.type === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/msbayindir/rag-chunker', 'X-Title': 'rag-chunker' }
        : {}),
      ...provider.headers,
    },
    maxRetries: 0,
    timeout: provider.timeoutMs,
  })
}

/** json_schema → json_object → plain prompt; servers that reject a mode are remembered. */
type JsonMode = 'json_schema' | 'json_object' | 'prompt'

function isFormatRejection(err: unknown): boolean {
  const status = (err as { status?: number }).status
  const msg = String((err as Error).message ?? '')
  return (
    (status === 400 || status === 422 || status === 404) &&
    /response_format|json_schema|json_object|schema/i.test(msg)
  )
}

export class OpenAICompatibleLLM implements LLM {
  readonly ref: string
  private client: Promise<OpenAI> | null = null
  private jsonMode: JsonMode = 'json_schema'
  private caps: Promise<ModelCapabilities> | null = null

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
  ) {
    this.ref = `${provider.name}/${model}`
  }

  private getClient(): Promise<OpenAI> {
    this.client ??= createClient(this.provider)
    return this.client
  }

  private cacheablePrefix(): boolean {
    // OpenRouter forwards cache_control to Anthropic and Gemini models.
    return this.provider.type === 'openrouter' && /^(anthropic|google)\//.test(this.model)
  }

  private buildMessages(req: GenerateRequest, jsonHint: string | null): ChatMessage[] {
    const messages: ChatMessage[] = []
    const system = [req.system, jsonHint].filter(Boolean).join('\n\n')
    if (system) messages.push({ role: 'system', content: system })
    const content: ContentPart[] = []
    if (req.prefix) {
      const part: ContentPart & { cache_control?: { type: 'ephemeral' } } = { type: 'text', text: req.prefix }
      if (this.cacheablePrefix()) part.cache_control = { type: 'ephemeral' }
      content.push(part)
    }
    for (const p of req.parts) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text })
      else
        content.push({
          type: 'image_url',
          image_url: { url: `data:${p.mimeType};base64,${toBase64(p.data)}` },
        })
    }
    const onlyText = content.every((c) => c.type === 'text') && !this.cacheablePrefix()
    messages.push({
      role: 'user',
      content: onlyText ? content.map((c) => (c as { text: string }).text).join('\n\n') : content,
    })
    return messages
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.getClient()
    const usage: Usage = emptyUsage()
    const run = async (mode: JsonMode): Promise<GenerateResult> => {
      const hint =
        req.json && mode !== 'json_schema'
          ? `Respond with JSON only, matching this JSON Schema:\n${JSON.stringify(req.json.schema)}`
          : null
      const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: this.buildMessages(req, hint),
      }
      const limit = req.maxOutputTokens ?? 4096
      if (this.provider.type === 'openai') body.max_completion_tokens = limit
      else body.max_tokens = limit
      if (req.json && mode === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.json.name, schema: req.json.schema, strict: true },
        }
      } else if (req.json && mode === 'json_object') {
        body.response_format = { type: 'json_object' }
      }
      const res = await withRetry(
        () =>
          client.chat.completions.create(body, {
            signal: timeoutSignal(this.provider.timeoutMs, req.signal),
          }),
        { maxRetries: this.provider.maxRetries, signal: req.signal },
      )
      const choice = res.choices[0]
      const text = choice?.message?.content ?? ''
      usage.inputTokens += res.usage?.prompt_tokens ?? 0
      usage.outputTokens += res.usage?.completion_tokens ?? 0
      usage.cachedInputTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0
      usage.requests += 1
      if (choice?.finish_reason === 'content_filter') {
        throw new RagChunkerError('PROVIDER_ERROR', `${this.ref}: response blocked by the content filter`)
      }
      return { text, usage }
    }

    try {
      while (true) {
        try {
          return await run(req.json ? this.jsonMode : 'prompt')
        } catch (err) {
          if (req.json && this.jsonMode !== 'prompt' && isFormatRejection(err)) {
            this.jsonMode = this.jsonMode === 'json_schema' ? 'json_object' : 'prompt'
            continue
          }
          throw err
        }
      }
    } catch (err) {
      throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
    }
  }

  capabilities(): Promise<ModelCapabilities> {
    this.caps ??= this.loadCapabilities()
    return this.caps
  }

  private async loadCapabilities(): Promise<ModelCapabilities> {
    const fallback: ModelCapabilities = {
      contextWindow: this.provider.contextWindow ?? (this.provider.type === 'openai' ? 128_000 : 32_768),
      maxOutputTokens: 16_384,
      vision: true,
    }
    if (this.provider.contextWindow || this.provider.type !== 'openrouter') return fallback
    try {
      const res = await fetch(`${this.provider.baseURL}/models`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return fallback
      const body = (await res.json()) as {
        data?: Array<{
          id: string
          context_length?: number
          top_provider?: { max_completion_tokens?: number }
          architecture?: { input_modalities?: string[] }
        }>
      }
      const m = body.data?.find((d) => d.id === this.model)
      if (!m) return fallback
      return {
        contextWindow: m.context_length ?? fallback.contextWindow,
        maxOutputTokens: m.top_provider?.max_completion_tokens ?? fallback.maxOutputTokens,
        vision: m.architecture?.input_modalities ? m.architecture.input_modalities.includes('image') : true,
      }
    } catch {
      return fallback
    }
  }

  async dispose(): Promise<void> {}
}

const KNOWN_EMBEDDING_LIMITS: Array<[RegExp, number]> = [
  [/text-embedding-3|text-embedding-ada/, 8191],
  [/mistral-embed/, 8192],
]

export class OpenAICompatibleEmbedder implements Embedder {
  readonly ref: string
  readonly batchSize: number
  private client: Promise<OpenAI> | null = null

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
    private readonly dimensions?: number,
    batchSize?: number,
  ) {
    this.ref = `${provider.name}/${model}`
    this.batchSize = batchSize ?? 128
  }

  async maxInputTokens(): Promise<number> {
    if (this.provider.contextWindow) return this.provider.contextWindow
    return KNOWN_EMBEDDING_LIMITS.find(([re]) => re.test(this.model))?.[1] ?? 8191
  }

  async embed(texts: string[], _kind: EmbeddingKind, signal?: AbortSignal) {
    this.client ??= createClient(this.provider)
    const client = await this.client
    try {
      const res = await withRetry(
        () =>
          client.embeddings.create(
            {
              model: this.model,
              input: texts,
              encoding_format: 'float',
              ...(this.dimensions ? { dimensions: this.dimensions } : {}),
            },
            { signal: timeoutSignal(this.provider.timeoutMs, signal) },
          ),
        { maxRetries: this.provider.maxRetries, signal },
      )
      const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[])
      if (vectors.length !== texts.length) {
        throw new RagChunkerError(
          'PROVIDER_ERROR',
          `${this.ref}: expected ${texts.length} embeddings, got ${vectors.length}`,
        )
      }
      return {
        vectors,
        usage: { ...emptyUsage(), inputTokens: res.usage?.prompt_tokens ?? 0, requests: 1 },
      }
    } catch (err) {
      throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
    }
  }
}
