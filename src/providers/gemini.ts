import type { GoogleGenAI } from '@google/genai'
import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import { sha256 } from '../util/hash.js'
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
} from './types.js'

/** Explicit caches only pay off (and are only accepted) above a few thousand tokens. */
const MIN_CACHE_CHARS = 4096 * 3.5

async function createClient(provider: ResolvedProvider): Promise<GoogleGenAI> {
  const mod = await importOptional('@google/genai', 'The Gemini provider', () => import('@google/genai'))
  return new mod.GoogleGenAI({
    apiKey: provider.apiKey,
    httpOptions: {
      ...(provider.baseURL ? { baseUrl: provider.baseURL } : {}),
      headers: provider.headers,
      timeout: provider.timeoutMs,
    },
  })
}

function thinkingConfig(
  model: string,
  effort: GenerateRequest['effort'],
): Record<string, unknown> | undefined {
  if (!effort) return undefined
  if (/gemini-([3-9]|\d{2,})/.test(model)) {
    return { thinkingLevel: effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH' }
  }
  if (/gemini-2\.5-flash/.test(model) && effort === 'low') return { thinkingBudget: 0 }
  return undefined
}

function isCacheError(err: unknown): boolean {
  const msg = String((err as Error).message ?? '')
  return (
    /cached ?content|cache/i.test(msg) && [400, 403, 404].includes((err as { status?: number }).status ?? 0)
  )
}

export class GeminiLLM implements LLM {
  readonly ref: string
  private client: Promise<GoogleGenAI> | null = null
  private caps: Promise<ModelCapabilities> | null = null
  private readonly caches = new Map<string, Promise<string | null>>()
  private cachingDisabled = false

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
  ) {
    this.ref = `${provider.name}/${model}`
  }

  private getClient(): Promise<GoogleGenAI> {
    this.client ??= createClient(this.provider)
    return this.client
  }

  /** Creates (once) an explicit cache holding system + prefix; returns its name or null. */
  private cacheFor(system: string | undefined, prefix: string): Promise<string | null> {
    const key = sha256(`${system ?? ''}\u0000${prefix}`)
    let entry = this.caches.get(key)
    if (!entry) {
      entry = (async () => {
        try {
          const client = await this.getClient()
          const cache = await client.caches.create({
            model: this.model,
            config: {
              contents: [{ role: 'user', parts: [{ text: prefix }] }],
              ...(system ? { systemInstruction: system } : {}),
              ttl: '7200s',
            },
          })
          return cache.name ?? null
        } catch {
          return null
        }
      })()
      this.caches.set(key, entry)
    }
    return entry
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.getClient()
    const parts: Array<Record<string, unknown>> = req.parts.map((p) =>
      p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: toBase64(p.data) } },
    )
    const useCache = !!req.prefix && !this.cachingDisabled && req.prefix.length >= MIN_CACHE_CHARS
    const attempt = async (cached: string | null): Promise<GenerateResult> => {
      const contents = [
        {
          role: 'user',
          parts: cached || !req.prefix ? parts : [{ text: req.prefix }, ...parts],
        },
      ]
      const config: Record<string, unknown> = {
        maxOutputTokens: req.maxOutputTokens ?? 8192,
        abortSignal: timeoutSignal(this.provider.timeoutMs, req.signal),
      }
      if (cached) config.cachedContent = cached
      else if (req.system) config.systemInstruction = req.system
      if (req.json) {
        config.responseMimeType = 'application/json'
        config.responseJsonSchema = req.json.schema
      }
      const thinking = thinkingConfig(this.model, req.effort)
      if (thinking) config.thinkingConfig = thinking

      const res = await withRetry(
        () =>
          client.models.generateContent({
            model: this.model,
            contents: contents as never,
            config: config as never,
          }),
        { maxRetries: this.provider.maxRetries, signal: req.signal },
      )
      const candidate = res.candidates?.[0]
      const reason = candidate?.finishReason
      if (
        reason === 'SAFETY' ||
        reason === 'PROHIBITED_CONTENT' ||
        reason === 'BLOCKLIST' ||
        reason === 'RECITATION'
      ) {
        throw new RagChunkerError('PROVIDER_ERROR', `${this.ref}: response blocked (${reason})`)
      }
      const u = res.usageMetadata
      return {
        text: res.text ?? '',
        usage: {
          ...emptyUsage(),
          inputTokens: u?.promptTokenCount ?? 0,
          outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
          cachedInputTokens: u?.cachedContentTokenCount ?? 0,
          requests: 1,
        },
      }
    }

    try {
      const cached = useCache ? await this.cacheFor(req.system, req.prefix as string) : null
      try {
        return await attempt(cached)
      } catch (err) {
        if (cached && isCacheError(err)) {
          // Cache expired or was rejected: continue without explicit caching.
          this.cachingDisabled = true
          return await attempt(null)
        }
        throw err
      }
    } catch (err) {
      throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
    }
  }

  capabilities(): Promise<ModelCapabilities> {
    this.caps ??= (async () => {
      const fallback: ModelCapabilities = {
        contextWindow: this.provider.contextWindow ?? 1_000_000,
        maxOutputTokens: 65_536,
        vision: true,
      }
      if (this.provider.contextWindow) return fallback
      try {
        const client = await this.getClient()
        const info = await client.models.get({ model: this.model })
        return {
          contextWindow: info.inputTokenLimit ?? fallback.contextWindow,
          maxOutputTokens: info.outputTokenLimit ?? fallback.maxOutputTokens,
          vision: true,
        }
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
        return fallback
      }
    })()
    return this.caps
  }

  async dispose(): Promise<void> {
    const names = await Promise.all(this.caches.values())
    this.caches.clear()
    if (names.every((n) => n === null)) return
    const client = await this.getClient()
    await Promise.all(
      names
        .filter((n): n is string => n !== null)
        .map((name) => client.caches.delete({ name }).catch(() => {})),
    )
  }
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map((x) => x / norm) : v
}

export class GeminiEmbedder implements Embedder {
  readonly ref: string
  readonly batchSize: number
  private client: Promise<GoogleGenAI> | null = null
  private limit: Promise<number> | null = null

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
    private readonly dimensions?: number,
    batchSize?: number,
  ) {
    this.ref = `${provider.name}/${model}`
    this.batchSize = Math.min(100, batchSize ?? 100)
  }

  private getClient(): Promise<GoogleGenAI> {
    this.client ??= createClient(this.provider)
    return this.client
  }

  maxInputTokens(): Promise<number> {
    this.limit ??= (async () => {
      if (this.provider.contextWindow) return this.provider.contextWindow
      try {
        const info = await (await this.getClient()).models.get({ model: this.model })
        return info.inputTokenLimit ?? 2048
      } catch {
        return 2048
      }
    })()
    return this.limit
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal) {
    const client = await this.getClient()
    try {
      const res = await withRetry(
        () =>
          client.models.embedContent({
            model: this.model,
            contents: texts,
            config: {
              taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              ...(this.dimensions ? { outputDimensionality: this.dimensions } : {}),
              abortSignal: timeoutSignal(this.provider.timeoutMs, signal),
            },
          }),
        { maxRetries: this.provider.maxRetries, signal },
      )
      const vectors = (res.embeddings ?? []).map((e) => normalize(e.values ?? []))
      if (vectors.length !== texts.length) {
        throw new RagChunkerError(
          'PROVIDER_ERROR',
          `${this.ref}: expected ${texts.length} embeddings, got ${vectors.length}`,
        )
      }
      return { vectors, usage: { ...emptyUsage(), requests: 1 } }
    } catch (err) {
      throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
    }
  }
}
