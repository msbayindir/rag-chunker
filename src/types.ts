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

export interface ProgressEvent {
  stage: 'upload' | 'cache' | 'chunk' | 'context'
  done: number
  total: number
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
  /** PDF parse stratejisi. Default: 'vision-only' (v1 backward compat) */
  parser?: 'vision-only' | 'hybrid' | 'local-only'
  /** Hybrid modda local routing eşiği (0-1). Default: 0.7 */
  triageThreshold?: number
  /** Bu sayfaları triage'dan bağımsız her zaman Gemini'ye gönder. 1-based. */
  forceVisionPages?: number[]
  embeddingProvider?: import('./embeddings/types.js').IEmbeddingProvider
  logger?: import('./logger.js').ILogger
  onProgress?: (event: ProgressEvent) => void
}

// ─── Internal document model (triage + process pipeline) ─────────────────────

/** A parsed section from a PDF page (heading + body text). */
export interface NormalizedSection {
  /** Heading text, or null if the section has no heading. */
  heading: string | null
  /** Heading level (1-6), or null. */
  headingLevel: number | null
  /** Body text for this section. */
  body: string
  /** 1-based source page numbers contributing to this section. */
  sourcePages: number[]
  /** How this section was extracted. */
  parseMethod: 'local' | 'vision'
}

/** Parsed representation of the full document, used internally before chunking. */
export interface NormalizedDocument {
  sections: NormalizedSection[]
  metadata: DocumentMetadata
}

/** Extracted document metadata. */
export interface DocumentMetadata {
  title: string | null
  author: string | null
  pageCount: number
  /** sha256:<hex> hash of the source PDF buffer */
  sourceHash: string
  /** ISO 8601 timestamp */
  extractedAt: string
  extractionMethod: 'vision-only' | 'hybrid' | 'local-only'
}

// ─── process() types ──────────────────────────────────────────────────────────

/** Extended chunk result produced by process() with structure-aware metadata. */
export interface ExtendedChunkResult extends ChunkResult {
  /** Unique chunk identifier (e.g. "chunk-001"). */
  chunkId: string
  /** Full heading path from root to this chunk (e.g. ["Introduction", "Background"]). */
  sectionPath: string[]
  /** Human-readable heading hierarchy (e.g. ["H1: Introduction", "H2: Background"]). */
  headingHierarchy: string[]
  /** Content classification. */
  contentType: 'prose' | 'table' | 'mixed' | 'code' | 'figure_caption'
  /** How this chunk's source pages were extracted. */
  parseMethod: 'local' | 'vision'
  /** Approximate token count (chars / 4). */
  tokenCount: number
  /** Character count. */
  charCount: number
  /** Previous chunk ID, or null for the first chunk. */
  prevChunkId: string | null
  /** Next chunk ID, or null for the last chunk. */
  nextChunkId: string | null
}

/** Configuration for process(). Extends ChunkerConfig with output-specific options. */
export interface ProcessConfig extends ChunkerConfig {
  /** Chunking strategy. Default: 'structure-aware' */
  chunkingStrategy?: 'structure-aware' | 'semantic'
  /** Max tokens per chunk for structure-aware chunker. Default: 512 */
  maxChunkTokens?: number
  /** Do not split tables across chunk boundaries. Default: true */
  preserveTables?: boolean
  /** Do not split code blocks across chunk boundaries. Default: true */
  preserveCodeBlocks?: boolean
  /** If set, output files are written to this directory. */
  outputDir?: string
}

/** Heading node in the document structure tree. */
export interface HeadingNode {
  id: string
  text: string
  level: number
  markdownLineRange: [number, number]
  sourcePages: number[]
  children: HeadingNode[]
}

/** Table entry in document structure. */
export interface TableEntry {
  id: string
  caption: string | null
  rows: number
  columns: number
  markdownLineRange: [number, number]
  sourcePage: number
  parentHeading: string | null
}

/** Figure entry in document structure. */
export interface FigureEntry {
  id: string
  caption: string
  sourcePage: number
  parentHeading: string | null
}

/** Maps a source page to its markdown line range. */
export interface PageMapEntry {
  sourcePage: number
  markdownLineRange: [number, number]
}

/** Document structure map produced by process(). */
export interface DocumentStructure {
  version: '2.0'
  headings: HeadingNode[]
  tables: TableEntry[]
  figures: FigureEntry[]
  pageMap: PageMapEntry[]
}

/** API call counts in the manifest. */
export interface ApiCallCounts {
  vision_parse: number
  context_summary: number
  embedding: number
  total: number
}

/** Cost/usage summary in the manifest. */
export interface ProcessCosts {
  estimated_input_tokens: number
  estimated_output_tokens: number
  api_calls: ApiCallCounts
}

/** Pipeline configuration snapshot in the manifest. */
export interface PipelineSummary {
  parser: 'vision-only' | 'hybrid' | 'local-only'
  vision_provider: string
  context_model: string
  chunk_model: string
  triage_result: {
    local_pages: number
    vision_pages: number
    local_ratio: number
  }
  chunking_strategy: 'structure-aware' | 'semantic'
  context_mode: string
  context_batch_size: number
}

/** Input summary in the manifest. */
export interface InputSummary {
  filename: string
  format: 'pdf'
  hash: string
  size_bytes: number
  page_count: number
}

/** Chunk statistics in the manifest output section. */
export interface ChunkStats {
  min_tokens: number
  max_tokens: number
  avg_tokens: number
  median_tokens: number
}

/** process() pipeline summary manifest. */
export interface ProcessManifest {
  version: '2.0'
  rag_chunker_version: string
  created_at: string
  duration_ms: number
  input: InputSummary
  pipeline: PipelineSummary
  output: {
    total_chunks: number
    chunk_stats: ChunkStats
    content_types: Record<string, number>
    files: string[]
  }
  costs: ProcessCosts
}

/** Result returned by process(). */
export interface ProcessResult {
  /** Full document as Markdown with YAML frontmatter. */
  markdown: string
  /** Document structure map. */
  structure: DocumentStructure
  /** All chunks with extended metadata. */
  chunks: ExtendedChunkResult[]
  /** Pipeline summary manifest. */
  manifest: ProcessManifest
  /**
   * Writes document.md, structure.json, chunks.jsonl, and manifest.json
   * to the specified directory (creates it if needed).
   */
  save(outputDir: string): Promise<void>
}
