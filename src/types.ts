export type { DocumentStructure, ProcessManifest, TableRecord } from './output/types.js'
export type { HeadingCorrection } from './normalize/heading-fix.js'
export type { IEmbeddingProvider } from './embeddings/types.js'

export interface ChunkerConfig {
  /** Gemini API key — used for context enrichment and as OCR fallback */
  geminiApiKey?: string
  /** Mistral API key — primary OCR provider */
  mistralApiKey?: string
  /** Context generation mode. Default: 'none' */
  contextMode?: 'per-chunk' | 'batch' | 'none'
  /** Gemini model for context summaries. Default: 'gemini-2.0-flash' */
  contextModel?: string
  /** Number of chunks per batch in batch context mode. Default: 10 */
  contextBatchSize?: number
  /** Max tokens per chunk. Default: 512 */
  maxChunkTokens?: number
  /** Min tokens for a chunk to be emitted. Default: 50 */
  minChunkTokens?: number
  /** Tokens of overlap prepended from previous chunk. Default: 0 */
  overlapTokens?: number
  /** Keep tables in their own chunk. Default: true */
  preserveTables?: boolean
  /** Keep code blocks in their own chunk. Default: true */
  preserveCodeBlocks?: boolean
  /**
   * Path to OCR cache JSON file. Default: ~/.rag-chunker/ocr-cache.json.
   * Pass `false` to disable OCR caching.
   */
  ocrCachePath?: string | false
  /** OCR cache TTL in days. Default: 7 */
  ocrCacheTtlDays?: number
  /** Embedding provider for generating vector embeddings. Optional. */
  embeddingProvider?: import('./embeddings/types.js').IEmbeddingProvider
  /** Custom logger. Default: pino logger at INFO level. */
  logger?: import('./logger.js').ILogger
  /**
   * Use Gemini to detect and fix inconsistent heading levels produced by OCR.
   * Requires geminiApiKey. Fails gracefully if the API call fails.
   * Default: false
   */
  headingNormalization?: boolean
  /**
   * Warn when a mustPreserve chunk (table/code) exceeds this token count.
   * These chunks can't be split, so large values degrade embedding quality.
   * Default: 2000
   */
  warnLargeChunkTokens?: number
}

export interface Chunk {
  /** SHA-256 of rawContent (first 32 hex chars). Deterministic. */
  chunkId: string
  /** 0-based index in the chunks array */
  index: number
  /** Final content — rawContent with contextSummary prepended (if any) */
  content: string
  /** Markdown content without context summary */
  rawContent: string
  /** 2-sentence context summary, or empty string if contextMode is 'none' */
  contextSummary: string
  tokenCount: number
  contentType: 'text' | 'code' | 'table' | 'mixed'
  /** Heading breadcrumb from root to this chunk */
  sectionPath: string[]
  /** 1-based page number (from OCR page markers) */
  pageNumber: number
  prevChunkId: string | null
  nextChunkId: string | null
  embedding: number[]
  /** True for table/code chunks that must not be merged across boundaries */
  mustPreserve: boolean
}

export interface ProcessResult {
  chunks: Chunk[]
  /** Full document markdown with <!-- page N --> markers */
  markdown: string
  structure: import('./output/types.js').DocumentStructure
  manifest: import('./output/types.js').ProcessManifest
  /** Writes document.md, structure.json, chunks.jsonl, manifest.json to outputDir */
  save(outputDir: string): Promise<void>
}
