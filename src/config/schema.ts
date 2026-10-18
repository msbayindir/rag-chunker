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
  type: providerTypeSchema
    .optional()
    .describe(
      'Adapter to use. Optional for built-in names (openai, openrouter, anthropic, gemini, ollama, mistral, lmstudio).',
    ),
  baseURL: z.url().optional().describe('API base URL (proxies, LM Studio, vLLM, self-hosted gateways).'),
  apiKey: z
    .string()
    .min(1)
    .optional()
    .describe('Programmatic use only. Config files must not contain keys — use environment variables.'),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe("Environment variable holding the key (default: the provider's standard one)."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra HTTP headers sent with every request.'),
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Context window in tokens, for providers that cannot report it.'),
  maxContext: z
    .number()
    .int()
    .min(2048)
    .optional()
    .describe("Upper bound for Ollama's num_ctx; keeps memory use predictable. Default 32768."),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Maximum parallel requests to this provider.'),
  timeoutMs: z.number().int().positive().optional().describe('Per-request timeout in milliseconds.'),
  maxRetries: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Retries for transient errors (429, 5xx, network). Default 4.'),
})
export type ProviderConfig = z.infer<typeof providerConfigSchema>

const ocrSchema = z.strictObject({
  engine: z
    .string()
    .trim()
    .refine((v) => v === 'auto' || v === 'text-layer' || v === 'mistral' || MODEL_REF_RE.test(v), {
      error: 'ocr.engine must be "auto", "text-layer", "mistral" or "provider/model"',
    })
    .default('auto')
    .describe(
      '"auto" (Mistral if MISTRAL_API_KEY is set, else models.vision, else text layer), "text-layer", "mistral", or a vision model such as "ollama/gemma4:e4b-it-qat".',
    ),
  pages: z
    .enum(['auto', 'all', 'scanned'])
    .default('auto')
    .describe(
      'PDF pages sent to the OCR engine. "auto": all pages for Mistral, scanned pages for vision models.',
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe("Parallel page requests (default: the provider's concurrency)."),
  stripImages: z
    .boolean()
    .default(true)
    .describe('Remove image placeholders such as ![img-0.jpeg](img-0.jpeg).'),
  removeHeaderFooter: z
    .boolean()
    .default(true)
    .describe('Remove running headers, footers and page numbers that repeat across pages.'),
  minTextChars: z
    .number()
    .int()
    .min(0)
    .default(40)
    .describe('A PDF page with fewer extractable characters is treated as scanned.'),
})

const modelsSchema = z.strictObject({
  vision: modelRefSchema
    .optional()
    .describe('Vision model for scanned pages and images, e.g. "ollama/gemma4:e4b-it-qat".'),
  structure: modelRefSchema.optional().describe('LLM that repairs heading levels. Skipped when unset.'),
  context: modelRefSchema
    .optional()
    .describe('LLM that writes contextual-retrieval summaries. Skipped when unset.'),
  embedding: modelRefSchema
    .optional()
    .describe('Embedding model, e.g. "ollama/embeddinggemma". Skipped when unset.'),
})

const chunkSchema = z.strictObject({
  maxTokens: z.number().int().min(32).max(16384).default(512).describe('Maximum tokens per chunk.'),
  minTokens: z
    .number()
    .int()
    .min(0)
    .default(64)
    .describe('Smaller chunks are merged with a neighbour in the same section.'),
  overlapTokens: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Trailing sentences of the previous chunk added for context.'),
  hardBoundaryDepth: z
    .number()
    .int()
    .min(0)
    .max(6)
    .default(2)
    .describe('Headings at this depth or shallower always start a new chunk (2 = H1 and H2).'),
  preserveTables: z
    .boolean()
    .default(true)
    .describe('Keep tables in their own chunks (split by rows with the header repeated).'),
  preserveCode: z.boolean().default(true).describe('Keep code blocks in their own chunks.'),
  tokenizer: z
    .enum(['o200k', 'estimate'])
    .default('o200k')
    .describe('"o200k" counts real BPE tokens; "estimate" is a fast character-based approximation.'),
})

const contextSchema = z.strictObject({
  strategy: z
    .enum(['auto', 'full', 'hierarchical'])
    .default('auto')
    .describe(
      '"full" sends the whole document, "hierarchical" sends document + section summaries, "auto" picks by size.',
    ),
  batchSize: z.number().int().min(1).max(50).default(8).describe('Chunks summarised per request.'),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe("Parallel requests (default: the provider's concurrency)."),
})

const embeddingSchema = z.strictObject({
  dimensions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Output dimensions for models that support it (Gemini, OpenAI text-embedding-3, EmbeddingGemma).',
    ),
  batchSize: z.number().int().min(1).max(2048).optional().describe('Texts per embedding request.'),
})

const layoutSchema = z.strictObject({
  engine: z
    .enum(['auto', 'off', 'pp-doclayout-v3'])
    .default('auto')
    .describe(
      'Page layout analysis for PDFs with a local ONNX model (block classes + reading order). "auto": on when onnxruntime-node and the downloaded model are present; "pp-doclayout-v3": on, downloading the model (130 MB) on first use; "off": position heuristics only.',
    ),
  minScore: z.number().min(0).max(1).default(0.5).describe('Minimum detection confidence.'),
  render: z
    .number()
    .int()
    .min(512)
    .max(2048)
    .default(1024)
    .describe('Longer page side, in pixels, of the render the model sees.'),
})

const cacheSchema = z.strictObject({
  enabled: z
    .boolean()
    .default(true)
    .describe('Cache OCR pages, summaries and embeddings so reruns are free and resumable.'),
  dir: z.string().min(1).optional().describe('Cache folder (default ~/.rag-chunker/cache).'),
})

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    ocr: ocrSchema.prefault({}).describe('How text is extracted.'),
    models: modelsSchema
      .prefault({})
      .describe('Models per stage as "provider/model". A stage without a model is skipped.'),
    providers: z
      .record(
        z
          .string()
          .regex(PROVIDER_NAME_RE, { error: 'Provider names may only contain letters, digits, - and _' }),
        providerConfigSchema,
      )
      .default({})
      .describe(
        'Provider settings and custom OpenAI-compatible endpoints, keyed by the name used in model references.',
      ),
    chunk: chunkSchema.prefault({}).describe('Chunk sizes and boundaries.'),
    context: contextSchema.prefault({}).describe('Contextual retrieval settings.'),
    embedding: embeddingSchema.prefault({}).describe('Embedding settings.'),
    layout: layoutSchema.prefault({}).describe('Local page layout analysis (PDF).'),
    cache: cacheSchema.prefault({}).describe('On-disk cache.'),
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
