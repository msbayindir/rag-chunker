import { z } from 'zod'

const MODEL_REF_RE = /^[a-z0-9][a-z0-9_-]*\/\S.*$/i
const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i

export const modelRefSchema = z
  .string()
  .trim()
  .regex(MODEL_REF_RE, { error: 'Use "provider/model", for example "ollama/gemma4:e4b-it-qat"' })

export const providerTypeSchema = z.enum([
  'openai',
  'openai-compatible',
  'openrouter',
  'anthropic',
  'gemini',
  'ollama',
  'mistral',
])
export type ProviderType = z.infer<typeof providerTypeSchema>

export const providerConfigSchema = z.strictObject({
  /** Adapter to use. Optional for built-in provider names (openai, anthropic, gemini, ollama, ...). */
  type: providerTypeSchema.optional(),
  /** Override the API base URL (proxies, LM Studio, vLLM, self-hosted gateways). */
  baseURL: z.url().optional(),
  /** Programmatic use only. Config files must not contain keys — use environment variables. */
  apiKey: z.string().min(1).optional(),
  /** Environment variable that holds the API key. Defaults to the provider's standard variable. */
  apiKeyEnv: z.string().min(1).optional(),
  /** Extra HTTP headers sent with every request. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Context window override in tokens (when the provider cannot report it). */
  contextWindow: z.number().int().positive().optional(),
  /** Upper bound for Ollama's num_ctx. Keeps memory use predictable. Default 32768. */
  maxContext: z.number().int().min(2048).optional(),
  /** Maximum parallel requests to this provider. */
  concurrency: z.number().int().min(1).max(64).optional(),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().optional(),
  /** Retries for transient errors (429, 5xx, network). Default 4. */
  maxRetries: z.number().int().min(0).max(10).optional(),
})
export type ProviderConfig = z.infer<typeof providerConfigSchema>

const ocrSchema = z.strictObject({
  /** "auto", "text-layer", "mistral" or a vision model reference such as "ollama/gemma4:e4b-it-qat". */
  engine: z
    .string()
    .trim()
    .refine((v) => v === 'auto' || v === 'text-layer' || v === 'mistral' || MODEL_REF_RE.test(v), {
      error: 'ocr.engine must be "auto", "text-layer", "mistral" or "provider/model"',
    })
    .default('auto'),
  /** Which pages go to the OCR engine. "auto": all pages for Mistral, scanned pages for vision models. */
  pages: z.enum(['auto', 'all', 'scanned']).default('auto'),
  /** Parallel page requests for vision OCR. Defaults to the provider's concurrency. */
  concurrency: z.number().int().min(1).max(32).optional(),
  /** Remove image placeholders such as ![img-0.jpeg](img-0.jpeg). */
  stripImages: z.boolean().default(true),
  /** Remove running headers and footers that repeat across pages. */
  removeHeaderFooter: z.boolean().default(true),
  /** A PDF page with fewer extractable characters than this is treated as scanned. */
  minTextChars: z.number().int().min(0).default(40),
})

const modelsSchema = z.strictObject({
  /** Vision model used for OCR of scanned pages and images. */
  vision: modelRefSchema.optional(),
  /** LLM that fixes heading levels. Stage is skipped when unset. */
  structure: modelRefSchema.optional(),
  /** LLM that writes contextual-retrieval summaries. Stage is skipped when unset. */
  context: modelRefSchema.optional(),
  /** Embedding model. Stage is skipped when unset. */
  embedding: modelRefSchema.optional(),
})

const chunkSchema = z.strictObject({
  maxTokens: z.number().int().min(32).max(16384).default(512),
  minTokens: z.number().int().min(0).default(64),
  overlapTokens: z.number().int().min(0).default(0),
  /** Headings at this depth or shallower always start a new chunk (H1 + H2 by default). */
  hardBoundaryDepth: z.number().int().min(0).max(6).default(2),
  preserveTables: z.boolean().default(true),
  preserveCode: z.boolean().default(true),
  /** "o200k" is a real BPE tokenizer; "estimate" is a fast character-based approximation. */
  tokenizer: z.enum(['o200k', 'estimate']).default('o200k'),
})

const contextSchema = z.strictObject({
  /** "full" sends the whole document, "hierarchical" sends summaries + neighbours, "auto" picks. */
  strategy: z.enum(['auto', 'full', 'hierarchical']).default('auto'),
  /** Chunks summarised per request. */
  batchSize: z.number().int().min(1).max(50).default(8),
  concurrency: z.number().int().min(1).max(32).optional(),
})

const embeddingSchema = z.strictObject({
  /** Output dimensions for models that support truncation (Gemini, OpenAI text-embedding-3). */
  dimensions: z.number().int().positive().optional(),
  batchSize: z.number().int().min(1).max(2048).optional(),
})

const cacheSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Defaults to ~/.rag-chunker/cache */
  dir: z.string().min(1).optional(),
})

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    ocr: ocrSchema.prefault({}),
    models: modelsSchema.prefault({}),
    providers: z
      .record(
        z
          .string()
          .regex(PROVIDER_NAME_RE, { error: 'Provider names may only contain letters, digits, - and _' }),
        providerConfigSchema,
      )
      .default({}),
    chunk: chunkSchema.prefault({}),
    context: contextSchema.prefault({}),
    embedding: embeddingSchema.prefault({}),
    cache: cacheSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.chunk.minTokens >= cfg.chunk.maxTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunk', 'minTokens'],
        message: 'chunk.minTokens must be smaller than chunk.maxTokens',
      })
    }
    if (cfg.chunk.overlapTokens > Math.floor(cfg.chunk.maxTokens / 2)) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunk', 'overlapTokens'],
        message: 'chunk.overlapTokens must be at most half of chunk.maxTokens',
      })
    }
  })

/** Configuration accepted by `processDocument`, config files and `defineConfig`. Every field is optional. */
export type RagChunkerConfig = z.input<typeof configSchema>
/** Configuration after defaults are applied. */
export type ResolvedConfig = z.output<typeof configSchema>

/** Identity helper that gives editor autocompletion in rag-chunker.config.mjs. */
export function defineConfig(config: RagChunkerConfig): RagChunkerConfig {
  return config
}
