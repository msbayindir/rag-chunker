import { createDefaultLogger } from './logger.js'
import { uploadPdf } from './gemini/file-upload.js'
import { createCache } from './gemini/context-cache.js'
import {
  loadRegistry, saveRegistry, getPdfHash,
  findFileRef, findCacheRef, setFileRef, setCacheRef,
  getFileExpiry, formatRemaining, DEFAULT_REGISTRY_PATH
} from './gemini/registry.js'
import { splitIntoGroups } from './pdf/page-splitter.js'
import { determineChunks } from './pdf/chunk-determiner.js'
import { generateContext, generateContextBatch } from './context/summarizer.js'
import { processWithPool } from './pipeline/pool.js'
import type { ChunkerConfig, ChunkerResult, ChunkResult, RawChunk, CacheRef, PageGroup, FileRef } from './types.js'

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

  const chunkModel   = config.chunkModel   ?? config.geminiModel ?? 'gemini-1.5-pro'
  const contextModel = config.contextModel ?? config.geminiModel ?? 'gemini-1.5-pro'

  const signals: AbortSignal[] = []
  if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
  if (config.abortSignal) signals.push(config.abortSignal)
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

  const startTime = Date.now()

  // Registry init
  const registryEnabled = config.cacheRegistry !== false
  const registryPath = typeof config.cacheRegistry === 'string'
    ? config.cacheRegistry
    : DEFAULT_REGISTRY_PATH
  const registry = registryEnabled ? loadRegistry(registryPath) : null
  const pdfHash  = registry ? getPdfHash(pdfBuffer) : null

  // B) Step 1: PDF Upload — registry'de varsa atla
  let fileRef: FileRef
  const cachedFile = registry && pdfHash ? findFileRef(registry, pdfHash) : null
  if (cachedFile) {
    const expiry = getFileExpiry(registry!, pdfHash!)
    logger.info('File registry\'den alindi', {
      name: cachedFile.name,
      kalan: expiry ? formatRemaining(expiry) : '?'
    })
    fileRef = cachedFile
  } else {
    fileRef = await uploadPdf(pdfBuffer, { apiKey, logger })
    if (registry && pdfHash) {
      setFileRef(registry, pdfHash, fileRef)
      saveRegistry(registryPath, registry)
    }
  }

  // C) Steps 2+3: Cache(s) and Page Groups (parallel)
  // Context modeli chunk modelinden farklıysa ve context atlanmıyorsa ikinci cache gerekir.
  const needsContextCache = !config.skipContext && contextModel !== chunkModel

  // Cache oluştur veya registry'den al
  const findOrCreateCache = async (model: string): Promise<CacheRef | null> => {
    const cached = registry && pdfHash ? findCacheRef(registry, pdfHash, model) : null
    if (cached) {
      logger.info('Cache registry\'den alindi', { model, kalan: formatRemaining(cached.expireTime) })
      return cached
    }
    const created = await createCache(fileRef, { apiKey, model, logger })
    if (created && registry && pdfHash) {
      setCacheRef(registry, pdfHash, created)
      saveRegistry(registryPath, registry)
    }
    return created
  }

  const [chunkCacheRef, maybeContextCacheRef, pageGroups] = await Promise.all([
    findOrCreateCache(chunkModel),
    needsContextCache
      ? findOrCreateCache(contextModel)
      : Promise.resolve(null as CacheRef | null),
    splitIntoGroups(pdfBuffer, {
      groupSize: config.groupSize,
      pageRange: config.pageRange,
      maxPages: config.maxPages
    })
  ])

  const contextCacheRef: CacheRef | null = needsContextCache ? maybeContextCacheRef : chunkCacheRef
  const cacheUsed = chunkCacheRef !== null
  const totalPages = pageGroups.reduce(
    (sum, g) => sum + g.pageRange.end - g.pageRange.start + 1,
    0
  )

  logger.info('Pipeline basladi', {
    totalPages,
    groupCount: pageGroups.length,
    cacheUsed,
    chunkModel,
    contextModel,
    contextMode: config.skipContext ? 'skip' : (config.contextMode ?? 'per-chunk')
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
        const rc = await determineChunks(g, i, fileRef, chunkCacheRef, {
          apiKey, model: chunkModel, logger, maxChunkChars: config.maxChunkChars ?? 3000
        })
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

  const concurrency = config.maxConcurrentChunks ?? 3
  const chunkDelay  = config.perChunkDelayMs ?? 500

  // G) Steps 5+6: Context + Embedding
  if (!config.skipContext && config.contextMode === 'batch') {
    // ── BATCH MODE: N chunk → tek API çağrısı ──────────────────────────────
    const batchSize = config.contextBatchSize ?? 10
    const batches: Array<Array<ChunkWork & { rawChunk: RawChunk }>> = []
    for (let i = 0; i < validWorks.length; i += batchSize) {
      batches.push(validWorks.slice(i, i + batchSize))
    }

    // Pass 1: context batch üret
    const contextMap = new Map<number, string>()
    const contextFailedSet = new Set<number>()

    await processWithPool(
      batches,
      concurrency,
      chunkDelay,
      async (batch) => {
        if (combinedSignal?.aborted) return
        try {
          const summaries = await generateContextBatch(
            batch.map(w => w.rawChunk),
            fileRef,
            contextCacheRef,
            { apiKey, model: contextModel, logger }
          )
          batch.forEach((w, i) => {
            const s = summaries[i]
            if (s !== null && s !== undefined) contextMap.set(w.chunkIndex, s)
            else contextFailedSet.add(w.chunkIndex)
          })
          logger.debug('Batch context tamamlandi', { batchChunkCount: batch.length })
        } catch (err) {
          logger.warn('Batch context basarisiz', { batchChunkCount: batch.length, err })
          batch.forEach(w => contextFailedSet.add(w.chunkIndex))
        }
      },
      combinedSignal
    )

    // Pass 2: embedding per-chunk (contextMap'ten al)
    await processWithPool(
      validWorks,
      concurrency,
      chunkDelay,
      async (w) => {
        if (combinedSignal?.aborted) return
        const rc = w.rawChunk
        const contextSummary = contextMap.get(w.chunkIndex) ?? ''
        const failedSteps: Array<'context' | 'embedding'> = []
        if (contextFailedSet.has(w.chunkIndex)) failedSteps.push('context')

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

        const pageRange = { start: Math.min(...rc.pages), end: Math.max(...rc.pages) }
        finalResults[w.chunkIndex] = {
          chunkIndex: w.chunkIndex, pageRange,
          text: rc.text, contextSummary, contentHint: rc.contentHint,
          status: failedSteps.length > 0 ? 'partial' : 'success',
          ...(failedSteps.length > 0 && { failedSteps }),
          ...(embedding !== undefined && { embedding })
        }
        logger.debug('Chunk tamamlandi', { chunkIndex: w.chunkIndex, status: finalResults[w.chunkIndex].status })
      },
      combinedSignal
    )

  } else {
    // ── PER-CHUNK MODE (default) veya skipContext ──────────────────────────
    await processWithPool(
      validWorks,
      concurrency,
      chunkDelay,
      async (w) => {
        if (combinedSignal?.aborted) return

        const rc = w.rawChunk
        const pageRange = { start: Math.min(...rc.pages), end: Math.max(...rc.pages) }
        const failedSteps: Array<'context' | 'embedding'> = []
        let contextSummary = ''

        // Context summary (skipContext=true ise atla)
        if (!config.skipContext) {
          try {
            contextSummary = await generateContext(rc, fileRef, contextCacheRef, {
              apiKey, model: contextModel, logger
            })
          } catch (err) {
            logger.warn('Context summary basarisiz', { chunkIndex: w.chunkIndex, err })
            failedSteps.push('context')
          }
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
  }

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
