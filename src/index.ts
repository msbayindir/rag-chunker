import { createDefaultLogger } from './logger.js'
import { uploadPdf } from './gemini/file-upload.js'
import { createCache } from './gemini/context-cache.js'
import { splitIntoGroups } from './pdf/page-splitter.js'
import { determineChunks } from './pdf/chunk-determiner.js'
import { generateContext } from './context/summarizer.js'
import { processWithPool } from './pipeline/pool.js'
import type { ChunkerConfig, ChunkerResult, ChunkResult, RawChunk, PageGroup } from './types.js'

type GroupResult =
  | { ok: true; rawChunks: RawChunk[] }
  | { ok: false; pageRange: { start: number; end: number } }

interface ChunkWork {
  chunkIndex: number
  rawChunk?: RawChunk
  errorResult?: ChunkResult
}

/**
 * Main pipeline: uploads PDF, creates context cache, splits into page groups,
 * determines chunk boundaries, generates context summaries, and optionally embeds.
 */
export async function chunk(
  pdfBuffer: Buffer | Uint8Array,
  config: ChunkerConfig
): Promise<ChunkerResult> {
  // A) Preparation
  const logger = config.logger ?? createDefaultLogger()
  const apiKey = config.geminiApiKey
  const model = config.geminiModel ?? 'gemini-1.5-pro'

  const signals: AbortSignal[] = []
  if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
  if (config.abortSignal) signals.push(config.abortSignal)
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

  const startTime = Date.now()

  // B) Step 1: PDF Upload (serial, throws on failure)
  const fileRef = await uploadPdf(pdfBuffer, { apiKey, logger })

  // C) Steps 2+3: Cache and Page Groups (parallel)
  const [cacheRef, pageGroups] = await Promise.all([
    createCache(fileRef, { apiKey, model, logger }),
    splitIntoGroups(pdfBuffer, {
      groupSize: config.groupSize,
      pageRange: config.pageRange,
      maxPages: config.maxPages
    })
  ])

  const cacheUsed = cacheRef !== null
  const totalPages = pageGroups.reduce(
    (sum, g) => sum + g.pageRange.end - g.pageRange.start + 1,
    0
  )

  logger.info('Pipeline basladi', {
    totalPages,
    groupCount: pageGroups.length,
    cacheUsed
  })

  // D) Step 4: Chunk Determination (group pool)
  const groupResults: GroupResult[] = new Array(pageGroups.length)

  await processWithPool(
    pageGroups.map((g, i) => ({ g, i })),
    config.maxConcurrentGroups ?? 3,
    config.perGroupDelayMs ?? 300,
    async ({ g, i }: { g: PageGroup; i: number }) => {
      if (combinedSignal?.aborted) {
        groupResults[i] = { ok: false, pageRange: g.pageRange }
        return
      }
      try {
        const rc = await determineChunks(g, i, fileRef, cacheRef, { apiKey, model, logger, maxChunkChars: config.maxChunkChars ?? 3000 })
        groupResults[i] = { ok: true, rawChunks: rc }
        logger.info('Grup islendi', { groupIndex: i, chunkCount: rc.length })
      } catch (err) {
        logger.error('Grup basarisiz', { groupIndex: i, err })
        groupResults[i] = { ok: false, pageRange: g.pageRange }
      }
    },
    combinedSignal
  )

  // E) Global chunkIndex assignment + work list preparation
  const works: ChunkWork[] = []
  let idx = 0

  for (const gr of groupResults) {
    if (!gr.ok) {
      works.push({
        chunkIndex: idx,
        errorResult: {
          chunkIndex: idx,
          pageRange: gr.pageRange,
          text: '',
          contextSummary: '',
          contentHint: 'mixed',
          status: 'error'
        }
      })
      idx++
    } else {
      for (const rc of gr.rawChunks) {
        works.push({ chunkIndex: idx++, rawChunk: rc })
      }
    }
  }

  // F) finalResults pre-fill (timeout default)
  const finalResults: ChunkResult[] = new Array(works.length)

  for (const w of works) {
    if (w.errorResult) {
      finalResults[w.chunkIndex] = w.errorResult
    } else {
      const rc = w.rawChunk!
      finalResults[w.chunkIndex] = {
        chunkIndex: w.chunkIndex,
        pageRange: { start: Math.min(...rc.pages), end: Math.max(...rc.pages) },
        text: rc.text,
        contextSummary: '',
        contentHint: rc.contentHint,
        status: 'timeout'
      }
    }
  }

  // Only valid works (with rawChunk) go into the pool
  const validWorks = works.filter((w): w is ChunkWork & { rawChunk: RawChunk } =>
    w.rawChunk !== undefined
  )

  // G) Steps 5+6: Context + Embedding (chunk pool)
  await processWithPool(
    validWorks,
    config.maxConcurrentChunks ?? 3,
    config.perChunkDelayMs ?? 500,
    async (w) => {
      if (combinedSignal?.aborted) return  // 'timeout' pre-fill stays

      const rc = w.rawChunk
      const pageRange = { start: Math.min(...rc.pages), end: Math.max(...rc.pages) }
      const failedSteps: Array<'context' | 'embedding'> = []
      let contextSummary = ''

      // Context summary
      try {
        contextSummary = await generateContext(rc, fileRef, cacheRef, { apiKey, model, logger })
      } catch (err) {
        logger.warn('Context summary basarisiz', { chunkIndex: w.chunkIndex, err })
        failedSteps.push('context')
      }

      // Embedding
      let embedding: number[] | undefined
      if (config.embeddingProvider) {
        try {
          const input = `${contextSummary}\n\n${rc.text}`
          const embedResult = await config.embeddingProvider.embed([input])
          const vec = embedResult[0]
          if (vec && vec.length > 0) embedding = vec
        } catch (err) {
          logger.warn('Embedding basarisiz', { chunkIndex: w.chunkIndex, err })
          failedSteps.push('embedding')
        }
      }

      const result: ChunkResult = {
        chunkIndex: w.chunkIndex,
        pageRange,
        text: rc.text,
        contextSummary,
        contentHint: rc.contentHint,
        status: failedSteps.length > 0 ? 'partial' : 'success',
        ...(failedSteps.length > 0 && { failedSteps }),
        ...(embedding !== undefined && { embedding })
      }

      finalResults[w.chunkIndex] = result
      logger.debug('Chunk tamamlandi', {
        chunkIndex: w.chunkIndex,
        status: result.status,
        failedSteps
      })
    },
    combinedSignal
  )

  // H) Result
  const durationMs = Date.now() - startTime
  logger.info('Pipeline tamamlandi', {
    totalChunks: finalResults.length,
    durationMs,
    cacheUsed
  })

  return {
    chunks: finalResults,
    cacheUsed,
    totalPages,
    durationMs
  }
}

// Public exports
export { createGeminiEmbeddingProvider } from './embedding/gemini.provider.js'
export { createOpenAiEmbeddingProvider } from './embedding/openai.provider.js'
export { createNullEmbeddingProvider } from './embedding/null.provider.js'
export { createDefaultLogger } from './logger.js'

export type {
  ChunkerConfig,
  ChunkerResult,
  ChunkResult,
  FileRef,
  CacheRef,
  PageGroup,
  RawChunk
} from './types.js'
export type { IEmbeddingProvider } from './embedding/types.js'
export type { ILogger } from './logger.js'
