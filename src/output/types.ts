export interface DocumentHeading {
  level: number
  text: string
  pageNumber: number
  /** 1-based line number in the full document markdown */
  markdownLine: number
}

export interface TableRecord {
  index: number
  caption: string | null
  pageNumber: number
  rowCount: number
  columnCount: number
}

export interface DocumentStructure {
  headings: DocumentHeading[]
  tables: TableRecord[]
  tableCount: number
  codeBlockCount: number
  pageCount: number
  totalTokens: number
}

export interface ChunkStats {
  total: number
  avgTokens: number
  minTokens: number
  maxTokens: number
  tableChunks: number
  codeChunks: number
  textChunks: number
  mixedChunks: number
}

export interface ProcessManifest {
  version: string
  processedAt: string
  pdfHash: string
  ocrModel: string
  contextModel: string
  contextMode: string
  chunkStats: ChunkStats
  durationMs: number
  ocrCacheHit: boolean
  /** Heading normalization result. null if headingNormalization was not enabled. */
  headingFix: {
    corrections: number
    skipped: boolean
    documentType: string | null
    mainSectionsFound: number
    phase1DurationMs: number
    phase2DurationMs: number
  } | null
  /** Context enrichment stats. null if contextMode is 'none'. */
  contextEnrichment: {
    model: string
    chunksEnriched: number
    chunksSkipped: number
    batchCalls: number
    durationMs: number
    cacheUsed: boolean
  } | null
}
