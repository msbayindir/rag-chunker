import { CacheStore } from './cache/store.js'
import { type ChunkOptions, chunkMarkdownDocument } from './chunker/chunker.js'
import { finalizeChunks } from './chunker/finalize.js'
import { getTokenizer } from './chunker/tokenizer.js'
import { DEFAULT_CACHE_DIR, resolveConfig } from './config/load.js'
import type { RagChunkerConfig } from './config/schema.js'
import { embedTexts as embedTextsInternal } from './embeddings/embed.js'
import { ProviderRegistry } from './providers/registry.js'
import type { EmbeddingKind } from './providers/types.js'
import type { Chunk } from './types.js'
import { sha256 } from './util/hash.js'

export { CacheStore } from './cache/store.js'
export type { ChunkOptions, ContentType } from './chunker/chunker.js'
export { getTokenizer, type Tokenizer } from './chunker/tokenizer.js'
export {
  CONFIG_FILE_NAMES,
  DEFAULT_CACHE_DIR,
  findConfigFile,
  type LoadConfigOptions,
  type LoadedConfig,
  loadConfig,
  loadConfigFile,
  mergeConfigs,
  readDotEnv,
  resolveConfig,
} from './config/load.js'
export { detectLocalModels, localPreset, recommendedGemma } from './config/presets.js'
export { BUILTIN_PROVIDERS } from './config/providers.js'
export {
  defineConfig,
  type ProviderConfig,
  type ProviderType,
  type RagChunkerConfig,
  type ResolvedConfig,
} from './config/schema.js'
export type { DocumentKind } from './documents/input.js'
export {
  type TableCell,
  type TableData,
  tableToHtml,
  tableToMarkdown,
} from './documents/tables.js'
export { type ErrorCode, isRagChunkerError, RagChunkerError } from './errors.js'
export {
  type EvalQuestion,
  type EvalReport,
  evaluate,
  generateQuestions,
  type ModeMetrics,
  type QuestionSet,
} from './eval/eval.js'
export { type TreeNode, tableTree, teds, treeEditDistance } from './eval/teds.js'
export {
  type ExportResult,
  type ExportTarget,
  exportToLanceDb,
  exportToPgvector,
  exportToQdrant,
  type SqlClient,
} from './export/export.js'
export {
  analyzeLayoutImage,
  createLayoutProvider,
  LAYOUT_LABELS,
  type LayoutLabel,
  type LayoutRegion,
  type PageLayoutProvider,
} from './local/layout.js'
export { ensureModel, hasModel, MODELS, type ModelId, modelsDir } from './local/models.js'
export { createOcrProvider, type OcrLine, type OcrResult, recognizeImage } from './local/ocr.js'
export {
  createTableStructureProvider,
  type ModelCell,
  type ModelTable,
  recognizeTableStructure,
  structureToGrid,
} from './local/table.js'
export { createMcpServer, type McpOptions } from './mcp/server.js'
export type { DocumentLayout, LayoutBlock, LayoutPage } from './output/layout.js'
export type { Manifest } from './output/manifest.js'
export type { DocumentStructure } from './output/structure.js'
export { type LoadedOutput, OUTPUT_FILES, type OutputPaths, readOutputDir } from './output/writer.js'
export type { ProgressEvent, ProgressListener, Stage } from './pipeline/events.js'
export { type PlanReport, planDocument } from './pipeline/plan.js'
export {
  hasLocalOcr,
  type LayoutPlan,
  type ProcessOptions,
  type ProcessResult,
  processDocument,
  resolveLayout,
  resolveOcrEngine,
} from './pipeline/process.js'
export { createEmbedder, createLLM, parseModelRef } from './providers/registry.js'
export type {
  ContentPart,
  Embedder,
  GenerateRequest,
  LLM,
  ModelCapabilities,
  Usage,
} from './providers/types.js'
export {
  Bm25Index,
  buildSearchIndex,
  type SearchHit,
  type SearchIndex,
  type SearchMode,
  search,
} from './search/search.js'
export type { Box, Chunk, ChunkBox } from './types.js'

/**
 * Chunks a markdown string without any provider (no OCR, context or embeddings).
 * `<!-- page N -->` markers, if present, set page numbers.
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions & { source?: string } = {}): Chunk[] {
  const { source = 'document.md', ...chunkOptions } = options
  const { chunks } = chunkMarkdownDocument(markdown, chunkOptions)
  const tok = getTokenizer(chunkOptions.tokenizer ?? 'o200k')
  return finalizeChunks({
    drafts: chunks,
    documentId: sha256(markdown),
    source,
    pageSources: new Map(),
    defaultSource: 'markdown',
    countTokens: (t) => tok.count(t),
  })
}

export interface EmbedOptions {
  /** Defaults to "document". Use "query" for search queries (Gemini/EmbeddingGemma use different prompts). */
  kind?: EmbeddingKind
  config?: RagChunkerConfig
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

/** Embeds texts with any embedding model reference, e.g. "ollama/embeddinggemma". */
export async function embedTexts(
  texts: string[],
  model: string,
  options: EmbedOptions = {},
): Promise<number[][]> {
  const config = resolveConfig(options.config)
  const registry = new ProviderRegistry({ config, env: options.env ?? process.env })
  const cache = new CacheStore(config.cache.enabled ? (config.cache.dir ?? DEFAULT_CACHE_DIR) : null)
  const res = await embedTextsInternal(texts, {
    embedder: registry.embedder(model),
    kind: options.kind ?? 'document',
    cache,
    dimensions: config.embedding.dimensions,
    signal: options.signal,
  })
  return res.vectors
}

/** Embeds one search query with the same model used for the chunks. */
export async function embedQuery(
  query: string,
  model: string,
  options: Omit<EmbedOptions, 'kind'> = {},
): Promise<number[]> {
  const [vector] = await embedTexts([query], model, { ...options, kind: 'query' })
  return vector as number[]
}
