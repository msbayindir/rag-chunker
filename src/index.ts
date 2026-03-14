import { createDefaultLogger } from './logger.js'
import { uploadPdf, createCache } from './providers/gemini.js'
import {
  loadRegistry, saveRegistry, getRegistryKey,
  findFileRef, findCacheRef, setFileRef, setCacheRef,
  getFileExpiry, formatRemaining, DEFAULT_REGISTRY_PATH
} from './context/cache-manager.js'
import { splitIntoGroups } from './pdf/page-splitter.js'
import { triagePages } from './pdf/triage.js'
import { parseLocalPages } from './pdf/local-parser.js'
import { determineChunks } from './chunker/semantic.js'
import { generateContext, generateContextBatch } from './context/contextual-retrieval.js'
import { processWithPool } from './utils/concurrency.js'
import type {
  ChunkerConfig, ChunkerResult, ChunkResult, RawChunk,
  CacheRef, PageGroup, FileRef, ProgressEvent, NormalizedSection
} from './types.js'

type GroupResult =
  | { ok: true; rawChunks: RawChunk[] }
  | { ok: false; pageRange: { start: number; end: number } }

interface ChunkWork {
  chunkIndex: number
  rawChunk?: RawChunk
  errorResult?: ChunkResult
}

/** Converts NormalizedSections from local parsing into RawChunks for the context pipeline. */
function sectionsToRawChunks(sections: NormalizedSection[], maxChunkChars: number): RawChunk[] {
  const chunks: RawChunk[] = []

  for (const section of sections) {
    const fullText = section.heading
      ? `${section.heading}\n\n${section.body}`
      : section.body

    if (!fullText.trim()) continue

    // Split oversized sections at paragraph boundaries
    if (fullText.length > maxChunkChars) {
      const paragraphs = fullText.split(/\n{2,}/)
      let current = ''
      for (const para of paragraphs) {
        if (current.length + para.length > maxChunkChars && current.length > 0) {
          chunks.push({
            pages: section.sourcePages,
            text: current.trim(),
            contentHint: 'narrative',
            groupIndex: -1
          })
          current = para
        } else {
          current += (current ? '\n\n' : '') + para
        }
      }
      if (current.trim()) {
        chunks.push({
          pages: section.sourcePages,
          text: current.trim(),
          contentHint: 'narrative',
          groupIndex: -1
        })
      }
    } else {
      chunks.push({
        pages: section.sourcePages,
        text: fullText.trim(),
        contentHint: 'narrative',
        groupIndex: -1
      })
    }
  }

  return chunks
}

/**
 * Main pipeline: uploads PDF, creates context cache, splits into page groups,
 * determines chunk boundaries, generates context summaries, and optionally embeds.
 *
 * Default `parser: 'vision-only'` preserves v1 behavior.
 * Set `parser: 'hybrid'` to route text-rich pages through local parsing (no Gemini vision cost).
 * Set `parser: 'local-only'` for fully offline extraction (no Gemini calls).
 */
export async function chunk(
  pdfBuffer: Buffer | Uint8Array,
  config: ChunkerConfig
): Promise<ChunkerResult> {
  // A) Preparation
  const logger = config.logger ?? createDefaultLogger()
  const apiKey = config.geminiApiKey
  const onProgress = config.onProgress
  const parser = config.parser ?? 'vision-only'

  const chunkModel   = config.chunkModel   ?? config.geminiModel ?? 'gemini-1.5-pro'
  const contextModel = config.contextModel ?? config.geminiModel ?? 'gemini-1.5-pro'

  const signals: AbortSignal[] = []
  if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
  if (config.abortSignal) signals.push(config.abortSignal)
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

  const startTime = Date.now()
  const maxChunkChars = config.maxChunkChars ?? 3000

  // ── LOCAL-ONLY: no Gemini at all ──────────────────────────────────────────
  if (parser === 'local-only') {
    logger.info('Local-only mode: PDF metin olarak parse ediliyor')
    // pageNums=[] → parseLocalPages includes all pages
    const allPagesDoc = await parseLocalPages(pdfBuffer, [], 'local-only')
    const rawChunks = sectionsToRawChunks(allPagesDoc.sections, maxChunkChars)

    logger.info('Local-only parse tamamlandi', {
      pageCount: allPagesDoc.metadata.pageCount,
      sectionCount: allPagesDoc.sections.length,
      chunkCount: rawChunks.length
    })
    onProgress?.({ stage: 'upload', done: 1, total: 1 })
    onProgress?.({ stage: 'cache', done: 1, total: 1 })
    onProgress?.({ stage: 'chunk', done: rawChunks.length, total: rawChunks.length })

    const finalResults: ChunkResult[] = rawChunks.map((rc, idx) => ({
      chunkIndex: idx,
      pageRange: { start: Math.min(...rc.pages), end: Math.max(...rc.pages) },
      text: rc.text,
      contextSummary: '',
      contentHint: rc.contentHint,
      status: 'success'
    }))

    return {
      chunks: finalResults,
      cacheUsed: false,
      totalPages: allPagesDoc.metadata.pageCount,
      durationMs: Date.now() - startTime
    }
  }

  // ── HYBRID or VISION-ONLY ─────────────────────────────────────────────────

  // Triage (only for hybrid mode)
  let localRawChunks: RawChunk[] = []
  let visionPageNums: number[] | null = null

  if (parser === 'hybrid') {
    const triageResult = await triagePages(pdfBuffer, {
      threshold: config.triageThreshold ?? 0.7,
      forceVisionPages: config.forceVisionPages
    })

    const localRatio = triageResult.localPages.length / triageResult.pageAnalyses.length
    const estimatedSavingPct = Math.round(localRatio * 100)

    logger.info('Triage tamamlandi', {
      totalPages: triageResult.pageAnalyses.length,
      localPages: triageResult.localPages.length,
      visionPages: triageResult.visionPages.length,
      estimatedCostSavingPct: estimatedSavingPct
    })

    visionPageNums = triageResult.visionPages

    if (triageResult.localPages.length > 0) {
      const localDoc = await parseLocalPages(pdfBuffer, triageResult.localPages, 'hybrid')
      localRawChunks = sectionsToRawChunks(localDoc.sections, maxChunkChars)
      logger.info('Local parse tamamlandi', {
        localPageCount: triageResult.localPages.length,
        localChunkCount: localRawChunks.length
      })
    }
  }

  // Registry init
  const registryEnabled = config.cacheRegistry !== false
  const registryPath = typeof config.cacheRegistry === 'string'
    ? config.cacheRegistry
    : DEFAULT_REGISTRY_PATH
  const registry = registryEnabled ? loadRegistry(registryPath) : null
  const pdfHash  = registry ? getRegistryKey(pdfBuffer, apiKey) : null

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
  onProgress?.({ stage: 'upload', done: 1, total: 1 })

  // C) Steps 2+3: Cache(s) and Page Groups (parallel)
  const needsContextCache = !config.skipContext && contextModel !== chunkModel

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

  // For hybrid: only split vision pages into groups
  const splitOpts = visionPageNums !== null && visionPageNums.length > 0
    ? {
        groupSize: config.groupSize,
        // Pass vision pages as an explicit list via pageRange start/end
        // Since pageRange only supports contiguous ranges, we rely on splitIntoGroups
        // filtering within page-splitter. For simplicity we pass the full buffer and
        // then filter groups that contain at least one vision page.
        pageRange: config.pageRange,
        maxPages: config.maxPages
      }
    : {
        groupSize: config.groupSize,
        pageRange: config.pageRange,
        maxPages: config.maxPages
      }

  const splitTask = (parser === 'hybrid' && visionPageNums !== null && visionPageNums.length === 0)
    ? Promise.resolve([] as PageGroup[])
    : splitIntoGroups(pdfBuffer, splitOpts)

  const [chunkCacheRef, maybeContextCacheRef, allPageGroups] = await Promise.all([
    findOrCreateCache(chunkModel),
    needsContextCache
      ? findOrCreateCache(contextModel)
      : Promise.resolve(null as CacheRef | null),
    splitTask
  ])

  // For hybrid: filter page groups to only include groups that overlap vision pages
  let pageGroups: PageGroup[]
  if (parser === 'hybrid' && visionPageNums !== null) {
    const visionSet = new Set(visionPageNums)
    pageGroups = allPageGroups.filter(g => {
      for (let p = g.pageRange.start; p <= g.pageRange.end; p++) {
        if (visionSet.has(p)) return true
      }
      return false
    })
  } else {
    pageGroups = allPageGroups
  }

  const contextCacheRef: CacheRef | null = needsContextCache ? maybeContextCacheRef : chunkCacheRef
  const cacheUsed = chunkCacheRef !== null
  const cacheTotal = needsContextCache ? 2 : 1
  onProgress?.({ stage: 'cache', done: 1, total: cacheTotal })
  if (needsContextCache) onProgress?.({ stage: 'cache', done: 2, total: 2 })

  const totalPages = allPageGroups.reduce(
    (sum, g) => sum + g.pageRange.end - g.pageRange.start + 1,
    0
  ) || localRawChunks.reduce(
    (maxPage, rc) => Math.max(maxPage, ...rc.pages),
    0
  )

  logger.info('Pipeline basladi', {
    totalPages,
    groupCount: pageGroups.length,
    localChunks: localRawChunks.length,
    cacheUsed,
    chunkModel,
    contextModel,
    contextMode: config.skipContext ? 'skip' : (config.contextMode ?? 'per-chunk')
  })

  // D) Step 4: Chunk Determination (group pool) — vision pages only
  const groupResults: GroupResult[] = new Array(pageGroups.length)
  let groupsDone = 0

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
          apiKey, model: chunkModel, logger, maxChunkChars
        })
        groupResults[i] = { ok: true, rawChunks: rc }
        logger.info('Grup islendi', { groupIndex: i, chunkCount: rc.length })
      } catch (err) {
        logger.error('Grup basarisiz', { groupIndex: i, err })
        groupResults[i] = { ok: false, pageRange: g.pageRange }
      }
      onProgress?.({ stage: 'chunk', done: ++groupsDone, total: pageGroups.length })
    },
    combinedSignal
  )

  // E) Global chunkIndex assignment: merge local + vision chunks in page order
  const visionRawChunks: RawChunk[] = []
  const errorResults: Array<{ pageRange: { start: number; end: number } }> = []

  for (const gr of groupResults) {
    if (!gr.ok) {
      errorResults.push({ pageRange: gr.pageRange })
    } else {
      visionRawChunks.push(...gr.rawChunks)
    }
  }

  // Merge local and vision chunks, sort by first page number
  const allRawChunks: RawChunk[] = [...localRawChunks, ...visionRawChunks]
  allRawChunks.sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages))

  const works: ChunkWork[] = []
  let idx = 0

  for (const rc of allRawChunks) {
    works.push({ chunkIndex: idx++, rawChunk: rc })
  }
  for (const er of errorResults) {
    works.push({
      chunkIndex: idx,
      errorResult: {
        chunkIndex: idx,
        pageRange: er.pageRange,
        text: '',
        contextSummary: '',
        contentHint: 'mixed',
        status: 'error'
      }
    })
    idx++
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

    const contextMap = new Map<number, string>()
    const contextFailedSet = new Set<number>()
    let contextDone = 0

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
        contextDone += batch.length
        onProgress?.({ stage: 'context', done: Math.min(contextDone, validWorks.length), total: validWorks.length })
      },
      combinedSignal
    )

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
        logger.debug('Chunk tamamlandi', { chunkIndex: w.chunkIndex, status: finalResults[w.chunkIndex]!.status })
      },
      combinedSignal
    )

  } else {
    // ── PER-CHUNK MODE (default) veya skipContext ──────────────────────────
    let contextDone = 0

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
        onProgress?.({ stage: 'context', done: ++contextDone, total: validWorks.length })
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
export { process } from './process.js'
export { createGeminiEmbeddingProvider } from './embeddings/gemini.provider.js'
export { createOpenAiEmbeddingProvider } from './embeddings/openai.provider.js'
export { createNullEmbeddingProvider } from './embeddings/null.provider.js'
export { createDefaultLogger } from './logger.js'

export type {
  ChunkerConfig,
  ChunkerResult,
  ChunkResult,
  ProgressEvent,
  FileRef,
  CacheRef,
  PageGroup,
  RawChunk,
  NormalizedDocument,
  NormalizedSection,
  DocumentMetadata,
  ProcessConfig,
  ProcessResult,
  ExtendedChunkResult,
  DocumentStructure,
  ProcessManifest
} from './types.js'
export type { IEmbeddingProvider } from './embeddings/types.js'
export type { ILogger } from './logger.js'
