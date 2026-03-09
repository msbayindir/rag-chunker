export interface FileRef {
  name: string      // "files/abc123"
  uri: string       // Gemini API URL
  mimeType: string  // "application/pdf"
}

export interface CacheRef {
  name: string        // "cachedContents/abc123"
  model: string       // "models/gemini-1.5-pro"
  expireTime: string  // ISO 8601 string
}

export interface PageGroup {
  pageRange: { start: number; end: number }  // 1-based, inclusive
  buffer: Uint8Array                          // pdf-lib save() output
}

export interface RawChunk {
  pages: number[]
  text: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  groupIndex: number
}

export interface ChunkResult {
  chunkIndex: number
  pageRange: { start: number; end: number }
  text: string
  contextSummary: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  embedding?: number[]
  status: 'success' | 'partial' | 'error' | 'timeout'
  failedSteps?: Array<'context' | 'embedding'>
}

export interface ChunkerResult {
  chunks: ChunkResult[]
  cacheUsed: boolean
  totalPages: number
  durationMs: number
}

export interface ChunkerConfig {
  geminiApiKey: string
  geminiModel?: string            // default: 'gemini-1.5-pro'
  groupSize?: number              // default: 15
  pageRange?: { start: number; end: number }
  maxPages?: number
  maxConcurrentGroups?: number    // default: 3
  maxConcurrentChunks?: number    // default: 3
  perGroupDelayMs?: number        // default: 300
  perChunkDelayMs?: number        // default: 500
  maxChunkChars?: number          // default: 3000 (~750 token). Prompt guideline + post-split guard.
  chunkModel?: string             // chunk belirleme modeli (default: geminiModel)
  contextModel?: string           // context summary modeli (default: geminiModel)
  skipContext?: boolean           // true → context generation tamamen atlanır (default: false)
  contextMode?: 'per-chunk' | 'batch'  // default: 'per-chunk'
  contextBatchSize?: number       // batch başına chunk sayısı (default: 10, sadece batch modda)
  cacheRegistry?: string | false  // registry JSON path; false=devre dışı; default: ~/.rag-chunker/registry.json
  timeoutMs?: number
  abortSignal?: AbortSignal
  embeddingProvider?: import('./embedding/types.js').IEmbeddingProvider
  logger?: import('./logger.js').ILogger
}
