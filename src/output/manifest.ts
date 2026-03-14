import type {
  ExtendedChunkResult, ProcessManifest, ProcessCosts,
  PipelineSummary, InputSummary, ChunkStats
} from '../types.js'

/** Package version injected at build time via the manifest builder. */
const RAG_CHUNKER_VERSION = '2.0.0'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

function computeChunkStats(chunks: ExtendedChunkResult[]): ChunkStats {
  if (chunks.length === 0) {
    return { min_tokens: 0, max_tokens: 0, avg_tokens: 0, median_tokens: 0 }
  }
  const tokens = chunks.map(c => c.tokenCount)
  return {
    min_tokens: Math.min(...tokens),
    max_tokens: Math.max(...tokens),
    avg_tokens: Math.round(tokens.reduce((s, t) => s + t, 0) / tokens.length),
    median_tokens: median(tokens)
  }
}

function computeContentTypes(chunks: ExtendedChunkResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const chunk of chunks) {
    counts[chunk.contentType] = (counts[chunk.contentType] ?? 0) + 1
  }
  return counts
}

export interface BuildManifestOpts {
  filename: string
  sizeBytes: number
  pageCount: number
  sourceHash: string
  parser: 'vision-only' | 'hybrid' | 'local-only'
  visionProvider: string
  contextModel: string
  chunkModel: string
  localPages: number
  visionPages: number
  chunkingStrategy: 'structure-aware' | 'semantic'
  contextMode: string
  contextBatchSize: number
  chunks: ExtendedChunkResult[]
  apiCalls: { vision_parse: number; context_summary: number; embedding: number }
  durationMs: number
  createdAt: string
}

/**
 * Builds the manifest.json object summarising a process() run.
 */
export function buildManifest(opts: BuildManifestOpts): ProcessManifest {
  const totalPages = opts.localPages + opts.visionPages
  const localRatio = totalPages > 0 ? opts.localPages / totalPages : 0

  const chunkStats = computeChunkStats(opts.chunks)
  const contentTypes = computeContentTypes(opts.chunks)

  // Token estimates: vision parse ~500 input per page, context ~200 output per chunk
  const estimatedInputTokens =
    opts.visionPages * 500 +
    opts.chunks.reduce((s, c) => s + c.tokenCount, 0)

  const estimatedOutputTokens =
    opts.chunks.filter(c => c.contextSummary).length * 200

  const costs: ProcessCosts = {
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    api_calls: {
      ...opts.apiCalls,
      total: opts.apiCalls.vision_parse + opts.apiCalls.context_summary + opts.apiCalls.embedding
    }
  }

  const pipeline: PipelineSummary = {
    parser: opts.parser,
    vision_provider: opts.visionProvider,
    context_model: opts.contextModel,
    chunk_model: opts.chunkModel,
    triage_result: {
      local_pages: opts.localPages,
      vision_pages: opts.visionPages,
      local_ratio: Math.round(localRatio * 100) / 100
    },
    chunking_strategy: opts.chunkingStrategy,
    context_mode: opts.contextMode,
    context_batch_size: opts.contextBatchSize
  }

  const input: InputSummary = {
    filename: opts.filename,
    format: 'pdf',
    hash: opts.sourceHash,
    size_bytes: opts.sizeBytes,
    page_count: opts.pageCount
  }

  return {
    version: '2.0',
    rag_chunker_version: RAG_CHUNKER_VERSION,
    created_at: opts.createdAt,
    duration_ms: opts.durationMs,
    input,
    pipeline,
    output: {
      total_chunks: opts.chunks.length,
      chunk_stats: chunkStats,
      content_types: contentTypes,
      files: ['document.md', 'structure.json', 'chunks.jsonl', 'manifest.json']
    },
    costs
  }
}
