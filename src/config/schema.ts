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
  'cohere',
  'jina',
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
    .refine(
      (v) => v === 'auto' || v === 'text-layer' || v === 'pp-ocr' || v === 'mistral' || MODEL_REF_RE.test(v),
      { error: 'ocr.engine must be "auto", "text-layer", "pp-ocr", "mistral" or "provider/model"' },
    )
    .default('auto')
    .describe(
      '"auto" (local PP-OCR when its models are downloaded, else Mistral if MISTRAL_API_KEY is set, else models.vision, else text layer), "text-layer", "pp-ocr" (local PP-OCRv5 on onnxruntime-node; downloads 13–97 MB once, see local.profile), "mistral", or a vision model such as "ollama/gemma4:e4b-it-qat".',
    ),
  pages: z
    .enum(['auto', 'all', 'scanned'])
    .default('auto')
    .describe(
      'PDF pages sent to the OCR engine. "auto": all pages for Mistral, scanned pages for local and vision models.',
    ),
  detector: z
    .enum(['auto', 'mobile', 'server'])
    .default('auto')
    .describe(
      'Text detector of the local OCR. "mobile": PP-OCRv5 mobile (5 MB, fast); "server": PP-OCRv5 server (84 MB, finds more small print and table cells, about 1.8× slower); "auto": follows local.profile.',
    ),
  script: z
    .enum(['auto', 'latin', 'cjk'])
    .default('auto')
    .describe(
      'Recogniser of the local OCR. "latin": the Latin-script model (Turkish, English, German, French, …). "cjk": the PP-OCRv5 server model for Chinese, Japanese and English (84 MB, about 10× slower per line, no Ğ/İ). "auto": with local.profile "full", the widest lines of a document\'s first scanned page are read with the CJK model and the document switches to it when they come back as CJK text; otherwise Latin.',
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

const localSchema = z.strictObject({
  profile: z
    .enum(['full', 'basic'])
    .default('full')
    .describe(
      'Which local models the "auto" choices pick. "full": the strongest models (server OCR detector; more to come), larger downloads; "basic": the small models (mobile OCR detector), smallest downloads and fastest.',
    ),
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

const figuresSchema = z.strictObject({
  extract: z
    .boolean()
    .default(true)
    .describe(
      'Cut the figures of PDF pages and images (embedded pictures; with layout analysis also charts and drawings) out as PNG files under figures/ and reference them from the markdown.',
    ),
  describe: z
    .boolean()
    .default(false)
    .describe(
      'Have models.vision describe every extracted figure (two to five sentences stored under the image, for retrieval). One vision request per figure.',
    ),
  minSize: z
    .number()
    .min(0)
    .max(1)
    .default(0.015)
    .describe('Smallest figure kept, as a share of the page area; icons and logos fall below it.'),
})

const rerankSchema = z.strictObject({
  engine: z
    .string()
    .trim()
    .refine(
      (v) =>
        v === 'auto' ||
        v === 'off' ||
        v === 'mmarco-minilm' ||
        v === 'bge-reranker-base' ||
        v === 'bge-reranker-v2-m3' ||
        MODEL_REF_RE.test(v),
      {
        error:
          'rerank.engine must be "auto", "off", a local model (mmarco-minilm, bge-reranker-base, bge-reranker-v2-m3) or "provider/model" (cohere/rerank-v3.5, jina/jina-reranker-v2-base-multilingual)',
      },
    )
    .default('auto')
    .describe(
      'Reranker that reorders the top search candidates (eval, mcp). "auto": the local mmarco-minilm when onnxruntime-node and the model are present; a local model id, downloaded on first use (mmarco-minilm 120 MB, 14 languages + transfer; bge-reranker-base 280 MB; bge-reranker-v2-m3 570 MB, 100+ languages, slow on CPU); a hosted one as "provider/model" (cohere/rerank-v3.5 with COHERE_API_KEY, jina/jina-reranker-v2-base-multilingual with JINA_API_KEY); "off".',
    ),
  candidates: z
    .number()
    .int()
    .min(5)
    .max(200)
    .default(30)
    .describe('First-stage results (hybrid or BM25) handed to the reranker.'),
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
    local: localSchema.prefault({}).describe('Which local models to use when a setting says "auto".'),
    figures: figuresSchema.prefault({}).describe('Figure extraction (PDF, images).'),
    rerank: rerankSchema.prefault({}).describe('Reranking of search results (eval, mcp).'),
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
