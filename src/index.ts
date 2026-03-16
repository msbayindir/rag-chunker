import { readFileSync } from 'fs'
import { getPdfHash, getRegistryKey } from './utils/crypto.js'
import { processWithPool } from './utils/concurrency.js'
import { runMistralOcr } from './ocr/mistral.js'
import { runGeminiVisionOcr } from './ocr/gemini-vision.js'
import {
  loadOcrRegistry,
  saveOcrRegistry,
  findOcrEntry,
  setOcrEntry,
  DEFAULT_OCR_CACHE_PATH
} from './context/cache.js'
import { chunkMarkdown, finalizeChunks } from './chunker/ast-chunker.js'
import { generateContext, generateContextBatch, createContextCache, type DocContext } from './context/gemini-context.js'
import { fixHeadingHierarchy } from './normalize/heading-fix.js'
import { buildDocumentMarkdown, buildStructure, buildManifest, saveOutputs } from './output/writer.js'
import { createDefaultLogger } from './logger.js'
import { splitPdf, MISTRAL_MAX_BYTES } from './utils/pdf-splitter.js'
import type { ChunkerConfig, Chunk, ProcessResult } from './types.js'
import type { OcrResult } from './ocr/types.js'

// ─── Public re-exports ────────────────────────────────────────────────────────

export type { ChunkerConfig, Chunk, ProcessResult } from './types.js'
export type { IEmbeddingProvider } from './embeddings/types.js'
export type { ILogger } from './logger.js'
export { createGeminiEmbeddingProvider } from './embeddings/gemini.js'
export { createOpenAiEmbeddingProvider } from './embeddings/openai.js'
export { createNullEmbeddingProvider } from './embeddings/null.js'
export { createDefaultLogger } from './logger.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONTEXT_MODEL = 'gemini-2.5-flash'
const DEFAULT_OCR_CACHE_TTL_DAYS = 7

// ─── process() ────────────────────────────────────────────────────────────────

/**
 * Full pipeline: OCR → AST chunk → Gemini context → embeddings → output.
 *
 * If `mistralApiKey` is provided, Mistral OCR 3 is used as the primary OCR provider.
 * Otherwise, Gemini Vision is used as fallback (requires `geminiApiKey`).
 *
 * @param pdfInput - Path to PDF file or Buffer
 * @param config   - Pipeline configuration
 */
export async function process(
  pdfInput: string | Buffer,
  config: ChunkerConfig
): Promise<ProcessResult> {
  const logger = config.logger ?? createDefaultLogger()
  const startedAt = Date.now()

  // ── 1. Read PDF buffer ──────────────────────────────────────────────────────
  const pdfBuffer: Buffer =
    typeof pdfInput === 'string' ? readFileSync(pdfInput) : pdfInput

  const pdfHash = getPdfHash(pdfBuffer)

  // ── 2. OCR cache setup ──────────────────────────────────────────────────────
  const cacheEnabled = config.ocrCachePath !== false
  const ocrCachePath =
    cacheEnabled && typeof config.ocrCachePath === 'string'
      ? config.ocrCachePath
      : DEFAULT_OCR_CACHE_PATH
  const ocrCacheTtlDays = config.ocrCacheTtlDays ?? DEFAULT_OCR_CACHE_TTL_DAYS

  const apiKeyForCache = config.mistralApiKey ?? config.geminiApiKey
  const cacheKey = apiKeyForCache
    ? getRegistryKey(pdfBuffer, apiKeyForCache)
    : pdfHash

  let fullMarkdown: string
  let ocrModel: string
  let pageCount: number
  let ocrCacheHit = false

  if (cacheEnabled) {
    const registry = loadOcrRegistry(ocrCachePath)
    const cached = findOcrEntry(registry, cacheKey, ocrCacheTtlDays)

    if (cached) {
      logger.info('OCR cache hit', { key: cacheKey.slice(0, 12) })
      ocrCacheHit = true
      fullMarkdown = cached.markdown
      ocrModel = cached.model
      pageCount = cached.pageCount
    } else {
      // ── 3a. Run OCR ──────────────────────────────────────────────────────
      const ocrResult = await runOcrWithSplit(pdfBuffer, config, logger)
      fullMarkdown = buildDocumentMarkdown(ocrResult)
      ocrModel = ocrResult.model
      pageCount = ocrResult.pageCount

      // ── 3b. Persist to cache ─────────────────────────────────────────────
      setOcrEntry(registry, cacheKey, {
        markdown: fullMarkdown,
        pageCount,
        model: ocrModel,
        cachedAt: new Date().toISOString()
      })
      saveOcrRegistry(ocrCachePath, registry)
      logger.info('OCR result cached', { key: cacheKey.slice(0, 12), pageCount })
    }
  } else {
    const ocrResult = await runOcrWithSplit(pdfBuffer, config, logger)
    fullMarkdown = buildDocumentMarkdown(ocrResult)
    ocrModel = ocrResult.model
    pageCount = ocrResult.pageCount
  }

  // ── 4. Heading normalization ──────────────────────────────────────────────────
  const contextMode = config.contextMode ?? 'none'
  const contextModel = config.contextModel ?? DEFAULT_CONTEXT_MODEL
  let headingFixManifest: import('./output/types.js').ProcessManifest['headingFix'] = null

  if (config.headingNormalization && config.geminiApiKey) {
    const headingFixResult = await fixHeadingHierarchy(fullMarkdown, {
      geminiApiKey: config.geminiApiKey,
      phase1Model: config.headingFixPhase1Model,
      phase2Model: config.headingFixPhase2Model,
      logger
    })
    fullMarkdown = headingFixResult.markdown
    headingFixManifest = {
      corrections: headingFixResult.corrections.length,
      skipped: headingFixResult.skipped,
      documentType: headingFixResult.structure?.documentType ?? null,
      mainSectionsFound: headingFixResult.structure?.mainSections.length ?? 0,
      phase1DurationMs: headingFixResult.phase1DurationMs,
      phase2DurationMs: headingFixResult.phase2DurationMs
    }
  } else if (config.headingNormalization && !config.geminiApiKey) {
    logger.warn('headingNormalization requires geminiApiKey — skipping')
  }

  // ── 5. Chunk the markdown ───────────────────────────────────────────────────
  logger.info('Chunking markdown', { pageCount })
  const chunkDatas = chunkMarkdown(fullMarkdown, {
    maxChunkTokens: config.maxChunkTokens,
    minChunkTokens: config.minChunkTokens,
    overlapTokens: config.overlapTokens,
    preserveTables: config.preserveTables,
    preserveCodeBlocks: config.preserveCodeBlocks,
    warnLargeChunkTokens: config.warnLargeChunkTokens,
    logger
  })
  const partialChunks = finalizeChunks(chunkDatas)
  logger.info('Chunks produced', { count: partialChunks.length })

  // ── 6. Context summaries ────────────────────────────────────────────────────
  const contextSummaries: string[] = new Array(partialChunks.length).fill('')
  let contextEnrichmentStats: import('./output/types.js').ProcessManifest['contextEnrichment'] = null

  if (contextMode !== 'none' && config.geminiApiKey) {
    logger.info('Generating context summaries', {
      mode: contextMode,
      chunks: partialChunks.length
    })

    const contextStartMs = Date.now()
    let contextCacheId: string | null = null
    let contextBatchCallCount = 0

    if (contextMode === 'batch') {
      logger.info('Context cache: creating')
      contextCacheId = await createContextCache(fullMarkdown, {
        apiKey: config.geminiApiKey,
        model: contextModel,
        logger
      })
      logger.info(contextCacheId ? 'Context cache: ready' : 'Context cache: unavailable — using inline text')
    }

    const docCtx: DocContext = contextCacheId
      ? { type: 'cache', cacheId: contextCacheId }
      : { type: 'text', markdown: fullMarkdown }

    if (contextMode === 'batch') {
      const batchSize = config.contextBatchSize ?? 10
      const totalBatches = Math.ceil(partialChunks.length / batchSize)
      for (let i = 0; i < partialChunks.length; i += batchSize) {
        const batchNum = Math.floor(i / batchSize) + 1
        const chunkEnd = Math.min(i + batchSize, partialChunks.length)
        logger.info(`Context batch ${batchNum}/${totalBatches} — chunks ${i + 1}–${chunkEnd}`)
        const batch = partialChunks.slice(i, chunkEnd)
        const summaries = await generateContextBatch(
          batch.map(c => ({
            rawContent: c.rawContent,
            sectionPath: c.sectionPath,
            pageNumber: c.pageNumber,
            mustPreserve: c.mustPreserve
          })),
          docCtx,
          { apiKey: config.geminiApiKey, model: contextModel, logger }
        )
        contextBatchCallCount++
        for (let j = 0; j < summaries.length; j++) {
          if (summaries[j] != null) contextSummaries[i + j] = summaries[j]!
        }
      }

      // Clean up the cache (TTL will handle it if delete fails)
      if (contextCacheId) {
        try {
          const ai = new (await import('@google/genai')).GoogleGenAI({ apiKey: config.geminiApiKey })
          await ai.caches.delete({ name: contextCacheId })
        } catch { /* TTL will expire it */ }
      }
    } else {
      // per-chunk — concurrent with rate-limit protection
      await processWithPool(
        partialChunks.map((_, idx) => idx),
        config.contextConcurrency ?? 2,
        500,
        async idx => {
          try {
            const summary = await generateContext(
              partialChunks[idx]!.rawContent,
              docCtx,
              { apiKey: config.geminiApiKey!, model: contextModel, logger }
            )
            contextSummaries[idx] = summary
          } catch (err) {
            logger.warn('Context generation failed', { chunkIndex: idx, err })
          }
        }
      )
    }

    const chunksEnriched = contextSummaries.filter(s => s.length > 0).length
    contextEnrichmentStats = {
      model: contextModel,
      chunksEnriched,
      chunksSkipped: partialChunks.length - chunksEnriched,
      batchCalls: contextBatchCallCount,
      durationMs: Date.now() - contextStartMs,
      cacheUsed: contextCacheId !== null
    }
  }

  // ── 6. Build final Chunk objects ────────────────────────────────────────────
  const chunks: Chunk[] = await Promise.all(
    partialChunks.map(async (pc, i): Promise<Chunk> => {
      const contextSummary = contextSummaries[i] ?? ''
      const content = contextSummary
        ? `Context: ${contextSummary}\n\n${pc.rawContent}`
        : pc.rawContent

      let embedding: number[] = []
      if (config.embeddingProvider) {
        try {
          const result = await config.embeddingProvider.embed([content])
          embedding = result[0] ?? []
        } catch {
          // embedding failure is non-fatal
        }
      }

      return {
        chunkId: pc.chunkId,
        index: pc.index,
        content,
        rawContent: pc.rawContent,
        contextSummary,
        tokenCount: pc.tokenCount,
        contentType: pc.contentType,
        sectionPath: pc.sectionPath,
        pageNumber: pc.pageNumber,
        prevChunkId: pc.prevChunkId,
        nextChunkId: pc.nextChunkId,
        mustPreserve: pc.mustPreserve,
        embedding
      }
    })
  )

  // ── 7. Build output objects ─────────────────────────────────────────────────
  const structure = buildStructure(fullMarkdown, chunks)
  const manifest = buildManifest({
    pdfHash,
    ocrModel,
    contextModel,
    contextMode,
    chunks,
    startedAt,
    ocrCacheHit,
    headingFix: headingFixManifest,
    contextEnrichment: contextEnrichmentStats
  })

  return {
    chunks,
    markdown: fullMarkdown,
    structure,
    manifest,
    async save(outputDir: string): Promise<void> {
      await saveOutputs(outputDir, fullMarkdown, structure, chunks, manifest)
    }
  }
}

// ─── chunk() — convenience wrapper ───────────────────────────────────────────

/**
 * Runs the full pipeline with contextMode forced to 'none' and returns only the chunks array.
 *
 * @param pdfInput - Path to PDF file or Buffer
 * @param config   - Pipeline configuration
 */
export async function chunk(
  pdfInput: string | Buffer,
  config: ChunkerConfig
): Promise<Chunk[]> {
  const result = await process(pdfInput, { ...config, contextMode: 'none' })
  return result.chunks
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function runOcrWithSplit(
  pdfBuffer: Buffer,
  config: ChunkerConfig,
  logger: ReturnType<typeof createDefaultLogger>
): Promise<OcrResult> {
  if (config.mistralApiKey && pdfBuffer.length > MISTRAL_MAX_BYTES) {
    const sizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(1)
    logger.info(`Large PDF (${sizeMB} MB) — splitting into batches`)
    const chunks = await splitPdf(pdfBuffer)
    logger.info(`Split into ${chunks.length} batches`)

    const allPages: OcrResult['pages'] = []
    let model = 'mistral-ocr-latest'

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      logger.info(`OCR batch ${i + 1}/${chunks.length} (pages ${chunk.pageOffset + 1}–${chunk.pageOffset + chunk.pageCount})`)
      const result = await runMistralOcr(chunk.buffer, { apiKey: config.mistralApiKey })
      model = result.model
      for (const page of result.pages) {
        allPages.push({ ...page, pageNumber: page.pageNumber + chunk.pageOffset })
      }
    }

    return { pages: allPages, model, pageCount: allPages.length }
  }

  return runOcr(pdfBuffer, config, logger)
}

async function runOcr(
  pdfBuffer: Buffer,
  config: ChunkerConfig,
  logger: ReturnType<typeof createDefaultLogger>
): Promise<OcrResult> {
  if (config.mistralApiKey) {
    logger.info('Running Mistral OCR')
    return runMistralOcr(pdfBuffer, { apiKey: config.mistralApiKey })
  }

  if (config.geminiApiKey) {
    logger.info('Running Gemini Vision OCR (fallback)')
    return runGeminiVisionOcr(pdfBuffer, { apiKey: config.geminiApiKey })
  }

  throw new Error(
    '[rag-chunker] No OCR provider configured — provide mistralApiKey or geminiApiKey'
  )
}
