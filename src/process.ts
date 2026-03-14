import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import { createDefaultLogger } from './logger.js'
import { uploadPdf, createCache } from './providers/gemini.js'
import {
  loadRegistry, saveRegistry, getRegistryKey,
  findFileRef, findCacheRef, setFileRef, setCacheRef,
  getFileExpiry, formatRemaining, DEFAULT_REGISTRY_PATH
} from './context/cache-manager.js'
import { triagePages } from './pdf/triage.js'
import { parseLocalPages } from './pdf/local-parser.js'
import { splitIntoGroups } from './pdf/page-splitter.js'
import { determineChunks } from './chunker/semantic.js'
import { chunkDocument } from './chunker/structure-aware.js'
import { generateContext, generateContextBatch } from './context/contextual-retrieval.js'
import { processWithPool } from './utils/concurrency.js'
import { buildMarkdown } from './output/markdown.js'
import { buildStructure } from './output/structure.js'
import { buildManifest } from './output/manifest.js'
import type {
  ProcessConfig, ProcessResult, ExtendedChunkResult,
  NormalizedDocument, NormalizedSection, CacheRef, FileRef, RawChunk
} from './types.js'

const PACKAGE_VERSION = '2.0.0'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChunkId(index: number): string {
  return `chunk-${String(index + 1).padStart(3, '0')}`
}

/** Converts RawChunks (from vision pipeline) to NormalizedSections for structure-aware chunking. */
function rawChunksToSections(rawChunks: RawChunk[]): NormalizedSection[] {
  return rawChunks.map(rc => ({
    heading: null,
    headingLevel: null,
    body: rc.text,
    sourcePages: rc.pages,
    parseMethod: 'vision' as const
  }))
}

// ─── process() ───────────────────────────────────────────────────────────────

/**
 * Full document processing pipeline.
 * Produces Markdown, structure map, extended chunks, and manifest.
 *
 * Unlike `chunk()`, this function accepts a file path (not a buffer),
 * uses structure-aware chunking by default, and returns rich output.
 */
export async function process(
  pdfPath: string,
  config: ProcessConfig
): Promise<ProcessResult> {
  const startTime = Date.now()
  const createdAt = new Date().toISOString()

  const logger = config.logger ?? createDefaultLogger()
  const apiKey = config.geminiApiKey
  const parser = config.parser ?? 'vision-only'
  const chunkingStrategy = config.chunkingStrategy ?? 'structure-aware'

  const chunkModel   = config.chunkModel   ?? config.geminiModel ?? 'gemini-2.0-flash'
  const contextModel = config.contextModel ?? config.geminiModel ?? 'gemini-2.0-flash'

  const signals: AbortSignal[] = []
  if (config.timeoutMs) signals.push(AbortSignal.timeout(config.timeoutMs))
  if (config.abortSignal) signals.push(config.abortSignal)
  const combinedSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

  // Read PDF
  const pdfBuffer = readFileSync(pdfPath)
  const sizeBytes = pdfBuffer.byteLength
  const filename = basename(pdfPath)
  const sourceHash = `sha256:${createHash('sha256').update(pdfBuffer).digest('hex')}`

  logger.info('process() basladi', { filename, sizeBytes, parser, chunkingStrategy })

  // ── Triage ────────────────────────────────────────────────────────────────
  let localPages: number[] = []
  let visionPages: number[] = []

  if (parser === 'local-only') {
    // No triage needed — will parse all locally
  } else if (parser === 'hybrid') {
    const triageResult = await triagePages(pdfBuffer, {
      threshold: config.triageThreshold ?? 0.7,
      forceVisionPages: config.forceVisionPages
    })
    localPages = triageResult.localPages
    visionPages = triageResult.visionPages
    logger.info('Triage tamamlandi', {
      localPages: localPages.length,
      visionPages: visionPages.length,
      estimatedCostSavingPct: Math.round(localPages.length / triageResult.pageAnalyses.length * 100)
    })
  } else {
    // vision-only: all pages go to vision — pageCount determined after parse
  }

  // ── Local parsing ─────────────────────────────────────────────────────────
  let localDoc: NormalizedDocument | null = null

  if (parser === 'local-only') {
    localDoc = await parseLocalPages(pdfBuffer, [], 'local-only')
    logger.info('Local-only parse tamamlandi', {
      pageCount: localDoc.metadata.pageCount,
      sections: localDoc.sections.length
    })
  } else if (parser === 'hybrid' && localPages.length > 0) {
    localDoc = await parseLocalPages(pdfBuffer, localPages, 'hybrid')
    logger.info('Local parse tamamlandi', {
      localPageCount: localPages.length,
      sections: localDoc.sections.length
    })
  }

  // ── Registry & upload (skip for local-only) ───────────────────────────────
  let fileRef: FileRef | null = null
  let chunkCacheRef: CacheRef | null = null
  let contextCacheRef: CacheRef | null = null
  let cacheUsed = false

  const needsGemini = parser !== 'local-only'
  const needsVisionParse = parser !== 'local-only' && (parser === 'vision-only' || visionPages.length > 0)

  if (needsGemini) {
    const registryEnabled = config.cacheRegistry !== false
    const registryPath = typeof config.cacheRegistry === 'string'
      ? config.cacheRegistry
      : DEFAULT_REGISTRY_PATH
    const registry = registryEnabled ? loadRegistry(registryPath) : null
    const pdfHash  = registry ? getRegistryKey(pdfBuffer, apiKey) : null

    // Upload
    const cachedFile = registry && pdfHash ? findFileRef(registry, pdfHash) : null
    if (cachedFile) {
      const expiry = getFileExpiry(registry!, pdfHash!)
      logger.info('File registry\'den alindi', { name: cachedFile.name, kalan: expiry ? formatRemaining(expiry) : '?' })
      fileRef = cachedFile
    } else {
      fileRef = await uploadPdf(pdfBuffer, { apiKey, logger })
      if (registry && pdfHash) {
        setFileRef(registry, pdfHash, fileRef)
        saveRegistry(registryPath, registry)
      }
    }

    config.onProgress?.({ stage: 'upload', done: 1, total: 1 })

    // Caches
    const needsContextCache = !config.skipContext && contextModel !== chunkModel

    const findOrCreateCache = async (model: string): Promise<CacheRef | null> => {
      const cached = registry && pdfHash ? findCacheRef(registry, pdfHash, model) : null
      if (cached) {
        logger.info('Cache registry\'den alindi', { model, kalan: formatRemaining(cached.expireTime) })
        return cached
      }
      const created = await createCache(fileRef!, { apiKey, model, logger })
      if (created && registry && pdfHash) {
        setCacheRef(registry, pdfHash, created)
        saveRegistry(registryPath, registry)
      }
      return created
    }

    chunkCacheRef = await findOrCreateCache(chunkModel)
    contextCacheRef = needsContextCache ? await findOrCreateCache(contextModel) : chunkCacheRef
    cacheUsed = chunkCacheRef !== null
  } else {
    config.onProgress?.({ stage: 'upload', done: 1, total: 1 })
  }

  config.onProgress?.({ stage: 'cache', done: 1, total: 1 })

  // ── Vision parsing ────────────────────────────────────────────────────────
  let visionSections: NormalizedSection[] = []
  let visionParseApiCalls = 0

  if (needsVisionParse && fileRef) {
    const pageGroupOpts = {
      groupSize: config.groupSize,
      pageRange: config.pageRange,
      maxPages: config.maxPages
    }
    const allPageGroups = await splitIntoGroups(pdfBuffer, pageGroupOpts)

    // For hybrid: only groups that overlap vision pages
    const pageGroups = parser === 'hybrid' && visionPages.length > 0
      ? (() => {
          const visionSet = new Set(visionPages)
          return allPageGroups.filter(g => {
            for (let p = g.pageRange.start; p <= g.pageRange.end; p++) {
              if (visionSet.has(p)) return true
            }
            return false
          })
        })()
      : allPageGroups

    const visionRawChunks: RawChunk[] = []
    let groupsDone = 0

    await processWithPool(
      pageGroups.map((g, i) => ({ g, i })),
      config.maxConcurrentGroups ?? 3,
      config.perGroupDelayMs ?? 300,
      async ({ g, i }) => {
        if (combinedSignal?.aborted) return
        try {
          const rc = await determineChunks(g, i, fileRef!, chunkCacheRef, {
            apiKey, model: chunkModel, logger, maxChunkChars: config.maxChunkChars ?? 3000
          })
          visionRawChunks.push(...rc)
          visionParseApiCalls++
        } catch (err) {
          logger.error('Vision grup basarisiz', { groupIndex: i, err })
        }
        config.onProgress?.({ stage: 'chunk', done: ++groupsDone, total: pageGroups.length })
      },
      combinedSignal
    )

    visionSections = rawChunksToSections(visionRawChunks)
    logger.info('Vision parse tamamlandi', { visionChunkCount: visionRawChunks.length })
  } else {
    config.onProgress?.({ stage: 'chunk', done: 1, total: 1 })
  }

  // ── Merge into NormalizedDocument ─────────────────────────────────────────
  const allSections: NormalizedSection[] = [
    ...(localDoc?.sections ?? []),
    ...visionSections
  ]
  // Sort by first source page
  allSections.sort((a, b) => (a.sourcePages[0] ?? 0) - (b.sourcePages[0] ?? 0))

  const pageCount = localDoc?.metadata.pageCount
    ?? (visionSections.reduce((max, s) => Math.max(max, ...s.sourcePages), 0))

  const mergedDoc: NormalizedDocument = {
    sections: allSections,
    metadata: {
      title: localDoc?.metadata.title ?? null,
      author: localDoc?.metadata.author ?? null,
      pageCount,
      sourceHash,
      extractedAt: createdAt,
      extractionMethod: parser
    }
  }

  // ── Chunking ──────────────────────────────────────────────────────────────
  let rawExtended: Omit<ExtendedChunkResult, 'chunkIndex' | 'chunkId' | 'contextSummary' | 'status' | 'prevChunkId' | 'nextChunkId'>[]

  if (chunkingStrategy === 'structure-aware') {
    rawExtended = chunkDocument(mergedDoc, {
      maxChunkTokens: config.maxChunkTokens,
      preserveTables: config.preserveTables,
      preserveCodeBlocks: config.preserveCodeBlocks
    })
  } else {
    // 'semantic': treat each section as a chunk
    rawExtended = allSections
      .filter(s => s.body.trim() || s.heading)
      .map(s => {
        const text = s.heading ? `${s.heading}\n\n${s.body}`.trim() : s.body.trim()
        return {
          pageRange: {
            start: Math.min(...s.sourcePages),
            end: Math.max(...s.sourcePages)
          },
          text,
          contentHint: 'narrative' as const,
          sectionPath: s.heading ? [s.heading] : [],
          headingHierarchy: s.heading && s.headingLevel !== null ? [`H${s.headingLevel}: ${s.heading}`] : [],
          contentType: 'prose' as const,
          parseMethod: s.parseMethod,
          tokenCount: Math.ceil(text.length / 4),
          charCount: text.length,
          embedding: undefined
        }
      })
  }

  // Assign IDs and indices
  const partialChunks: ExtendedChunkResult[] = rawExtended.map((r, i) => ({
    ...r,
    chunkIndex: i,
    chunkId: makeChunkId(i),
    contextSummary: '',
    status: 'timeout' as const,
    prevChunkId: i > 0 ? makeChunkId(i - 1) : null,
    nextChunkId: i < rawExtended.length - 1 ? makeChunkId(i + 1) : null
  }))

  // ── Context generation ────────────────────────────────────────────────────
  let contextApiCalls = 0

  if (!config.skipContext && fileRef) {
    // Convert to RawChunk-compatible shape for context functions
    const asRawChunks: RawChunk[] = partialChunks.map(c => ({
      pages: [c.pageRange.start, c.pageRange.end],
      text: c.text,
      contentHint: c.contentHint,
      groupIndex: c.chunkIndex
    }))

    if (config.contextMode === 'batch') {
      const batchSize = config.contextBatchSize ?? 10
      const batches: RawChunk[][] = []
      for (let i = 0; i < asRawChunks.length; i += batchSize) {
        batches.push(asRawChunks.slice(i, i + batchSize))
      }

      const contextMap = new Map<number, string>()
      let contextDone = 0

      await processWithPool(
        batches.map((batch, bi) => ({ batch, bi })),
        config.maxConcurrentChunks ?? 3,
        config.perChunkDelayMs ?? 500,
        async ({ batch, bi }) => {
          if (combinedSignal?.aborted) return
          try {
            const startIdx = bi * batchSize
            const summaries = await generateContextBatch(batch, fileRef!, contextCacheRef, {
              apiKey, model: contextModel, logger
            })
            summaries.forEach((s, i) => {
              if (s) contextMap.set(startIdx + i, s)
            })
            contextApiCalls++
          } catch (err) {
            logger.warn('Batch context basarisiz', { batchIndex: bi, err })
          }
          contextDone += batch.length
          config.onProgress?.({ stage: 'context', done: Math.min(contextDone, partialChunks.length), total: partialChunks.length })
        },
        combinedSignal
      )

      for (const chunk of partialChunks) {
        const summary = contextMap.get(chunk.chunkIndex)
        chunk.contextSummary = summary ?? ''
        chunk.status = summary ? 'success' : 'partial'
        if (!summary) chunk.failedSteps = ['context']
      }
    } else {
      // per-chunk mode
      let contextDone = 0
      await processWithPool(
        partialChunks,
        config.maxConcurrentChunks ?? 3,
        config.perChunkDelayMs ?? 500,
        async (chunk) => {
          if (combinedSignal?.aborted) return
          try {
            const rc = asRawChunks[chunk.chunkIndex]!
            chunk.contextSummary = await generateContext(rc, fileRef!, contextCacheRef, {
              apiKey, model: contextModel, logger
            })
            chunk.status = 'success'
            contextApiCalls++
          } catch (err) {
            logger.warn('Context basarisiz', { chunkIndex: chunk.chunkIndex, err })
            chunk.status = 'partial'
            chunk.failedSteps = ['context']
          }
          config.onProgress?.({ stage: 'context', done: ++contextDone, total: partialChunks.length })
        },
        combinedSignal
      )
    }
  } else {
    // No context — mark success
    for (const chunk of partialChunks) {
      chunk.status = 'success'
    }
    config.onProgress?.({ stage: 'context', done: partialChunks.length, total: partialChunks.length })
  }

  // ── Embedding ─────────────────────────────────────────────────────────────
  let embeddingApiCalls = 0
  if (config.embeddingProvider) {
    for (const chunk of partialChunks) {
      try {
        const input = `${chunk.contextSummary}\n\n${chunk.text}`
        const embedResult = await config.embeddingProvider.embed([input])
        const vec = embedResult[0]
        if (vec && vec.length > 0) {
          chunk.embedding = vec
          embeddingApiCalls++
        }
      } catch (err) {
        logger.warn('Embedding basarisiz', { chunkIndex: chunk.chunkIndex, err })
      }
    }
  }

  // ── Build outputs ─────────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime

  const markdownStr = buildMarkdown(mergedDoc, PACKAGE_VERSION)
  const structure = buildStructure(mergedDoc, markdownStr)
  const manifest = buildManifest({
    filename,
    sizeBytes,
    pageCount,
    sourceHash,
    parser,
    visionProvider: `${chunkModel}`,
    contextModel,
    chunkModel,
    localPages: localPages.length,
    visionPages: parser === 'vision-only' ? pageCount : visionPages.length,
    chunkingStrategy,
    contextMode: config.skipContext ? 'skip' : (config.contextMode ?? 'per-chunk'),
    contextBatchSize: config.contextBatchSize ?? 10,
    chunks: partialChunks,
    apiCalls: {
      vision_parse: visionParseApiCalls,
      context_summary: contextApiCalls,
      embedding: embeddingApiCalls
    },
    durationMs,
    createdAt
  })

  logger.info('process() tamamlandi', {
    totalChunks: partialChunks.length,
    durationMs,
    cacheUsed
  })

  // ── Return ProcessResult ──────────────────────────────────────────────────
  const result: ProcessResult = {
    markdown: markdownStr,
    structure,
    chunks: partialChunks,
    manifest,

    async save(outputDir: string): Promise<void> {
      mkdirSync(outputDir, { recursive: true })

      writeFileSync(join(outputDir, 'document.md'), result.markdown, 'utf-8')

      writeFileSync(
        join(outputDir, 'structure.json'),
        JSON.stringify(result.structure, null, 2),
        'utf-8'
      )

      writeFileSync(
        join(outputDir, 'chunks.jsonl'),
        result.chunks.map(c => JSON.stringify(c)).join('\n'),
        'utf-8'
      )

      writeFileSync(
        join(outputDir, 'manifest.json'),
        JSON.stringify(result.manifest, null, 2),
        'utf-8'
      )
    }
  }

  // Write to outputDir if configured
  if (config.outputDir) {
    await result.save(config.outputDir)
  }

  return result
}
