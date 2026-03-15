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
import { generateContext, generateContextBatch, type DocContext } from './context/gemini-context.js'
import { fixHeadingHierarchy, createDocumentCache } from './normalize/heading-fix.js'
import { buildDocumentMarkdown, buildStructure, buildManifest, saveOutputs } from './output/writer.js'
import { createDefaultLogger } from './logger.js'
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

const DEFAULT_CONTEXT_MODEL = 'gemini-2.0-flash'
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
      const ocrResult = await runOcr(pdfBuffer, config, logger)
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
    const ocrResult = await runOcr(pdfBuffer, config, logger)
    fullMarkdown = buildDocumentMarkdown(ocrResult)
    ocrModel = ocrResult.model
    pageCount = ocrResult.pageCount
  }

  // ── 4. Gemini document cache + heading normalization ──────────────────────────
  let headingCorrections = 0
  let geminiDocCacheId: string | null = null
  const contextMode = config.contextMode ?? 'none'
  const contextModel = config.contextModel ?? DEFAULT_CONTEXT_MODEL

  // Create a Gemini cache when we'll be sending the document to Gemini multiple times
  const needsGemini =
    config.geminiApiKey &&
    (config.headingNormalization || contextMode !== 'none')

  if (needsGemini && config.geminiApiKey) {
    logger.info('Creating Gemini document cache')
    geminiDocCacheId = await createDocumentCache(fullMarkdown, {
      apiKey: config.geminiApiKey,
      model: contextModel,
      logger
    })
  }

  const docCtx: DocContext = geminiDocCacheId
    ? { type: 'cache', cacheId: geminiDocCacheId }
    : { type: 'text', markdown: fullMarkdown }

  if (config.headingNormalization && config.geminiApiKey) {
    logger.info('Running heading normalization')
    const result = await fixHeadingHierarchy(fullMarkdown, {
      geminiApiKey: config.geminiApiKey,
      geminiModel: contextModel,
      cacheId: geminiDocCacheId,
      logger
    })
    fullMarkdown = result.correctedMd
    headingCorrections = result.corrections.length
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

  if (contextMode !== 'none' && config.geminiApiKey) {
    logger.info('Generating context summaries', {
      mode: contextMode,
      chunks: partialChunks.length
    })

    if (contextMode === 'batch') {
      const batchSize = config.contextBatchSize ?? 10
      for (let i = 0; i < partialChunks.length; i += batchSize) {
        const batch = partialChunks.slice(i, i + batchSize)
        const summaries = await generateContextBatch(
          batch.map(c => c.rawContent),
          docCtx,
          { apiKey: config.geminiApiKey, model: contextModel, logger }
        )
        for (let j = 0; j < summaries.length; j++) {
          if (summaries[j] != null) contextSummaries[i + j] = summaries[j]!
        }
      }
    } else {
      // per-chunk — concurrent with rate-limit protection
      await processWithPool(
        partialChunks.map((_, idx) => idx),
        3,
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
    headingCorrections
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
