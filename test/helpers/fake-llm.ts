import type { ResolvedProvider } from '../../src/config/providers.js'
import type {
  Embedder,
  EmbeddingKind,
  GenerateRequest,
  GenerateResult,
  LLM,
  ModelCapabilities,
} from '../../src/providers/types.js'

export const fakeProvider: ResolvedProvider = {
  name: 'fake',
  type: 'openai-compatible',
  baseURL: 'http://fake',
  apiKey: undefined,
  apiKeyEnv: [],
  headers: {},
  contextWindow: undefined,
  maxContext: 32768,
  concurrency: 2,
  timeoutMs: 1000,
  maxRetries: 0,
  local: true,
}

/** In-memory LLM: `respond` returns the model text for a request (or throws). */
export class FakeLLM implements LLM {
  readonly ref = 'fake/model'
  readonly provider = fakeProvider
  readonly model = 'model'
  readonly requests: GenerateRequest[] = []

  constructor(
    private readonly respond: (req: GenerateRequest, n: number) => string | Promise<string>,
    private readonly caps: Partial<ModelCapabilities> = {},
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req)
    const text = await this.respond(req, this.requests.length)
    return { text, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, requests: 1 } }
  }

  async capabilities(): Promise<ModelCapabilities> {
    return { contextWindow: 100_000, maxOutputTokens: 8192, vision: true, ...this.caps }
  }

  async dispose(): Promise<void> {}
}

export class FakeEmbedder implements Embedder {
  readonly ref = 'fake/embed'
  readonly provider = fakeProvider
  readonly model = 'embed'
  readonly batchSize: number
  readonly calls: Array<{ texts: string[]; kind: EmbeddingKind }> = []

  constructor(
    private readonly limit = 8000,
    batchSize = 4,
  ) {
    this.batchSize = batchSize
  }

  async maxInputTokens(): Promise<number> {
    return this.limit
  }

  async embed(texts: string[], kind: EmbeddingKind) {
    this.calls.push({ texts, kind })
    return {
      vectors: texts.map((t) => [t.length, kind === 'query' ? 1 : 0]),
      usage: { inputTokens: texts.length, outputTokens: 0, cachedInputTokens: 0, requests: 1 },
    }
  }
}

/** Pulls `<chunk id="N"` ids out of a context request. */
export function chunkIds(req: GenerateRequest): number[] {
  const text = req.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  return [...text.matchAll(/<chunk id="(\d+)"/g)].map((m) => Number(m[1]))
}
