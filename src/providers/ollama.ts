import type { Ollama } from 'ollama'
import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import { sha256 } from '../util/hash.js'
import { importOptional } from '../util/optional.js'
import { isRetryable, statusOf, timeoutSignal, toProviderError, withRetry } from './retry.js'
import {
  type Embedder,
  type EmbeddingKind,
  emptyUsage,
  type GenerateRequest,
  type GenerateResult,
  type LLM,
  type ModelCapabilities,
  textOf,
  toBase64,
} from './types.js'

interface ChatMessage {
  role: string
  content: string
  images?: string[]
}

interface ModelInfo {
  contextLength: number
  capabilities: string[]
  embeddingLength: number | undefined
}

async function client(provider: ResolvedProvider, signal?: AbortSignal): Promise<Ollama> {
  const mod = await importOptional('ollama', 'The Ollama provider', () => import('ollama'))
  const boundFetch: typeof fetch = (input, init) => {
    const signals = [init?.signal, signal].filter((s): s is AbortSignal => !!s)
    return fetch(input, { ...init, signal: signals.length > 0 ? AbortSignal.any(signals) : undefined })
  }
  return new mod.Ollama({ host: provider.baseURL as string, headers: provider.headers, fetch: boundFetch })
}

function ollamaError(err: unknown, provider: ResolvedProvider, model: string): RagChunkerError {
  const ref = `${provider.name}/${model}`
  const status = statusOf(err)
  const message = String((err as Error).message ?? err)
  if (status === 404 || /not found|try pulling/i.test(message)) {
    return new RagChunkerError('MODEL_NOT_FOUND', `${ref}: model is not installed in Ollama`, {
      status,
      cause: err,
      hint: `Run: ollama pull ${model}`,
    })
  }
  if (status === undefined && isRetryable(err)) {
    return new RagChunkerError('PROVIDER_UNAVAILABLE', `${ref}: cannot reach Ollama at ${provider.baseURL}`, {
      cause: err,
      retryable: true,
      hint: 'Start Ollama (open the app or run `ollama serve`), or set OLLAMA_HOST.',
    })
  }
  return toProviderError(err, ref)
}

const infoCache = new Map<string, Promise<ModelInfo>>()

/** Reads context length and capabilities from /api/show (cached per host + model). */
export function ollamaModelInfo(provider: ResolvedProvider, model: string): Promise<ModelInfo> {
  const key = `${provider.baseURL}|${model}`
  let entry = infoCache.get(key)
  if (!entry) {
    entry = (async () => {
      try {
        const c = await client(provider, AbortSignal.timeout(30_000))
        const res = await c.show({ model })
        const info = (
          res.model_info instanceof Map ? Object.fromEntries(res.model_info) : res.model_info
        ) as Record<string, unknown>
        const ctxKey = Object.keys(info ?? {}).find((k) => k.endsWith('.context_length'))
        const embKey = Object.keys(info ?? {}).find((k) => k.endsWith('.embedding_length'))
        return {
          contextLength: ctxKey ? Number(info[ctxKey]) : 8192,
          capabilities: res.capabilities ?? [],
          embeddingLength: embKey ? Number(info[embKey]) : undefined,
        }
      } catch (err) {
        infoCache.delete(key)
        throw ollamaError(err, provider, model)
      }
    })()
    infoCache.set(key, entry)
  }
  return entry
}

/** Lists installed model names (e.g. "gemma4:e4b-it-qat"). */
export async function ollamaListModels(provider: ResolvedProvider): Promise<string[]> {
  try {
    const c = await client(provider, AbortSignal.timeout(10_000))
    const res = await c.list()
    return res.models.map((m) => m.name)
  } catch (err) {
    throw ollamaError(err, provider, '')
  }
}

const roundUp = (n: number, step: number) => Math.ceil(n / step) * step
/** Shared prefixes at least this long are processed once on their own first (see `warmed`). */
const WARM_PREFIX_CHARS = 8000

export class OllamaLLM implements LLM {
  readonly ref: string
  /** Sticky num_ctx: changing it makes Ollama reload the model, so it only ever grows. */
  private numCtx = 0
  /**
   * Shared prefixes already processed at the current num_ctx. llama.cpp can reuse a cached prefix
   * of a sliding-window model (Gemma) only from a checkpoint that ends before the point where two
   * prompts diverge, and it takes checkpoints ~512 tokens before the end of each prompt. After a
   * request with a large batch of chunks that point lies past the shared document, so every later
   * request would process the whole document again. A one-token request carrying only the prefix
   * leaves a checkpoint just before the prefix ends, which all later requests restore.
   */
  private warmed = new Map<string, Promise<void>>()

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
  ) {
    this.ref = `${provider.name}/${model}`
  }

  async capabilities(): Promise<ModelCapabilities> {
    const info = await ollamaModelInfo(this.provider, this.model)
    if (!info.capabilities.includes('completion')) {
      throw new RagChunkerError(
        'CAPABILITY_MISSING',
        `${this.ref} cannot generate text (it is an embedding model)`,
      )
    }
    return {
      contextWindow: Math.min(info.contextLength, this.provider.maxContext),
      maxOutputTokens: 8192,
      vision: info.capabilities.includes('vision'),
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const info = await ollamaModelInfo(this.provider, this.model)
    const caps = await this.capabilities()
    const maxOut = req.maxOutputTokens ?? 4096
    const promptChars = (req.system?.length ?? 0) + (req.prefix?.length ?? 0) + textOf(req.parts).length
    const images = req.parts.filter((p) => p.type === 'image')
    // Conservative estimate (~3 chars/token) plus ~1.3k tokens per image.
    const needed = Math.ceil(promptChars / 3) + images.length * 1300 + maxOut + 256
    // Grow with 25% headroom in 4k steps so slightly larger requests later do not force another reload.
    if (needed > this.numCtx) {
      this.numCtx = Math.min(caps.contextWindow, roundUp(Math.max(needed * 1.25, 4096), 4096))
    }

    const userText = [req.prefix, textOf(req.parts)].filter(Boolean).join('\n\n')
    const messages: ChatMessage[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push({
      role: 'user',
      content: userText,
      ...(images.length > 0 ? { images: images.map((p) => toBase64((p as { data: Uint8Array }).data)) } : {}),
    })
    const call = (msgs: ChatMessage[], numPredict: number) =>
      withRetry(
        async () => {
          const c = await client(this.provider, timeoutSignal(this.provider.timeoutMs, req.signal))
          return c.chat({
            model: this.model,
            messages: msgs,
            stream: false,
            keep_alive: '10m',
            ...(req.json ? { format: req.json.schema } : {}),
            ...(info.capabilities.includes('thinking') ? { think: false } : {}),
            options: { num_ctx: this.numCtx, num_predict: numPredict, temperature: req.json ? 0 : 0.2 },
          })
        },
        { maxRetries: this.provider.maxRetries, signal: req.signal },
      )

    try {
      const usage = { ...emptyUsage() }
      if (req.prefix && req.prefix.length >= WARM_PREFIX_CHARS) {
        const key = sha256(`${this.numCtx}\u0000${req.system ?? ''}\u0000${req.prefix}`)
        let warm = this.warmed.get(key)
        if (!warm) {
          const prefixOnly = [...messages.slice(0, -1), { role: 'user', content: req.prefix }]
          warm = call(prefixOnly, 1).then((res) => {
            usage.inputTokens += res.prompt_eval_count ?? 0
            usage.outputTokens += res.eval_count ?? 0
            usage.requests++
          })
          this.warmed.set(key, warm)
          warm.catch(() => this.warmed.delete(key))
        }
        await warm
      }
      const res = await call(messages, maxOut)
      usage.inputTokens += res.prompt_eval_count ?? 0
      usage.outputTokens += res.eval_count ?? 0
      usage.requests++
      return { text: res.message?.content ?? '', usage }
    } catch (err) {
      throw ollamaError(err, this.provider, this.model)
    }
  }

  async dispose(): Promise<void> {}
}

/** Prompt prefixes some embedding models were trained with. */
function withTaskPrefix(model: string, text: string, kind: EmbeddingKind): string {
  if (/embeddinggemma/i.test(model)) {
    return kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`
  }
  if (/nomic-embed/i.test(model)) return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`
  return text
}

export class OllamaEmbedder implements Embedder {
  readonly ref: string
  readonly batchSize: number

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
    private readonly dimensions?: number,
    batchSize?: number,
  ) {
    this.ref = `${provider.name}/${model}`
    this.batchSize = batchSize ?? 32
  }

  async maxInputTokens(): Promise<number> {
    const info = await ollamaModelInfo(this.provider, this.model)
    if (!info.capabilities.includes('embedding')) {
      throw new RagChunkerError('CAPABILITY_MISSING', `${this.ref} is not an embedding model`, {
        hint: 'Use an embedding model such as ollama/embeddinggemma or ollama/nomic-embed-text.',
      })
    }
    // Leave room for the task prefix.
    return Math.max(256, info.contextLength - 16)
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal) {
    const info = await ollamaModelInfo(this.provider, this.model)
    const input = texts.map((t) => withTaskPrefix(this.model, t, kind))
    try {
      const res = await withRetry(
        async () => {
          const c = await client(this.provider, timeoutSignal(this.provider.timeoutMs, signal))
          return c.embed({
            model: this.model,
            input,
            truncate: true,
            keep_alive: '10m',
            ...(this.dimensions ? { dimensions: this.dimensions } : {}),
            options: { num_ctx: info.contextLength },
          })
        },
        { maxRetries: this.provider.maxRetries, signal },
      )
      if (res.embeddings.length !== texts.length) {
        throw new RagChunkerError(
          'PROVIDER_ERROR',
          `${this.ref}: expected ${texts.length} embeddings, got ${res.embeddings.length}`,
        )
      }
      return {
        vectors: res.embeddings,
        usage: { ...emptyUsage(), inputTokens: res.prompt_eval_count ?? 0, requests: 1 },
      }
    } catch (err) {
      throw ollamaError(err, this.provider, this.model)
    }
  }
}
