import { CacheStore } from '../cache/store.js'
import { type ChunkResult, chunkMarkdownDocument } from '../chunker/chunker.js'
import { finalizeChunks } from '../chunker/finalize.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import { DEFAULT_CACHE_DIR, resolveConfig } from '../config/load.js'
import type { RagChunkerConfig, ResolvedConfig } from '../config/schema.js'
import { enrichChunks } from '../context/enrich.js'
import { type DocumentInput, readDocument } from '../documents/input.js'
import { embedTexts } from '../embeddings/embed.js'
import { RagChunkerError, throwIfAborted } from '../errors.js'
import { extractDocument, type OcrEngine } from '../ocr/extract.js'
import { chunkStats, type Manifest, PACKAGE_VERSION, sanitizeConfig } from '../output/manifest.js'
import { buildStructure, type DocumentStructure } from '../output/structure.js'
import { type OutputPaths, writeOutputs } from '../output/writer.js'
import { ProviderRegistry } from '../providers/registry.js'
import { addUsage, emptyUsage, type Usage } from '../providers/types.js'
import { fixHeadings } from '../structure/heading-fix.js'
import type { Chunk } from '../types.js'
import { type ProgressListener, Reporter } from './events.js'

export interface ProcessOptions {
  /** Label stored as `source` in chunks (defaults to the file name, or "document" for bytes). */
  name?: string
  /** Environment used for API keys and OLLAMA_HOST. Defaults to process.env. */
  env?: Record<string, string | undefined>
  onProgress?: ProgressListener
  signal?: AbortSignal
}

export interface ProcessResult {
  chunks: Chunk[]
  /** Full document markdown with `<!-- page N -->` markers (after heading normalisation). */
  markdown: string
  structure: DocumentStructure
  manifest: Manifest
  warnings: string[]
  /** Writes chunks.jsonl, document.md, structure.json and manifest.json to `dir`. */
  save(dir: string): Promise<OutputPaths>
}

export interface PipelineContext {
  config: ResolvedConfig
  env: Record<string, string | undefined>
  cache: CacheStore
  registry: ProviderRegistry
}

export function createContext(
  config: RagChunkerConfig | undefined,
  env?: Record<string, string | undefined>,
): PipelineContext {
  const resolved = resolveConfig(config)
  const environment = env ?? process.env
  return {
    config: resolved,
    env: environment,
    cache: new CacheStore(resolved.cache.enabled ? (resolved.cache.dir ?? DEFAULT_CACHE_DIR) : null),
    registry: new ProviderRegistry({ config: resolved, env: environment }),
  }
}

/** Picks the OCR engine: explicit config wins; "auto" prefers Mistral, then a vision model, then the text layer. */
export function resolveOcrEngine(ctx: PipelineContext): { engine: OcrEngine; pages: 'all' | 'scanned' } {
  const { engine, pages } = ctx.config.ocr
  let resolved: OcrEngine
  if (engine === 'text-layer') resolved = { type: 'text-layer' }
  else if (engine === 'mistral') {
    const mistral = ctx.registry.provider('mistral')
    if (!mistral.apiKey) {
      throw new RagChunkerError('MISSING_API_KEY', 'ocr.engine is "mistral" but no Mistral API key is set', {
        hint: 'Set MISTRAL_API_KEY in your environment or .env file.',
      })
    }
    resolved = { type: 'mistral' }
  } else if (engine === 'auto') {
    const vision = ctx.config.models.vision
    if (ctx.registry.provider('mistral').apiKey) resolved = { type: 'mistral' }
    else if (vision) resolved = { type: 'vision', ref: vision }
    else resolved = { type: 'text-layer' }
  } else {
    resolved = { type: 'vision', ref: engine }
  }
  const mode = pages === 'auto' ? (resolved.type === 'mistral' ? 'all' : 'scanned') : pages
  return { engine: resolved, pages: mode }
}

function engineName(engine: OcrEngine): string {
  return engine.type === 'vision' ? engine.ref : engine.type
}

/**
 * Full pipeline: read → OCR → (heading fix) → chunk → (context) → (embeddings).
 * Stages without a configured model are skipped. Results are cached per page/chunk, so an
 * interrupted run resumes where it stopped.
 */
export async function processDocument(
  input: string | Uint8Array,
  config: RagChunkerConfig = {},
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const ctx = createContext(config, options.env)
  try {
    const doc = await readDocument(input, options.name)
    return await runPipeline(doc, ctx, options)
  } finally {
    await ctx.registry.dispose()
  }
}

export async function runPipeline(
  doc: DocumentInput,
  ctx: PipelineContext,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const startedAt = Date.now()
  const reporter = new Reporter(options.onProgress)
  const { config, cache, registry } = ctx
  const signal = options.signal
  const byStage: Record<string, Usage> = {}
  const tok = getTokenizer(config.chunk.tokenizer)

  reporter.start('read', doc.name)
  reporter.end('read', `${doc.kind}, ${doc.bytes.length} bytes`)

  // ── OCR ────────────────────────────────────────────────────────────────
  const { engine, pages } = resolveOcrEngine(ctx)
  let t = Date.now()
  reporter.start('ocr', engineName(engine))
  const extracted = await extractDocument(doc, {
    engine,
    pages,
    minTextChars: config.ocr.minTextChars,
    stripImages: config.ocr.stripImages,
    removeHeaderFooter: config.ocr.removeHeaderFooter,
    concurrency: config.ocr.concurrency,
    registry,
    cache,
    reporter,
    signal,
  })
  byStage.ocr = extracted.usage
  const ocrStage: Manifest['stages']['ocr'] = {
    engine: engineName(engine),
    model: extracted.ocrModel,
    pages: extracted.stats.pages,
    textLayerPages: extracted.stats.textLayerPages,
    ocrPages: extracted.stats.ocrPages,
    cachedPages: extracted.stats.cachedPages,
    scannedPages: extracted.stats.scannedPages,
    emptyPages: extracted.stats.emptyPages,
    headerFooterLinesRemoved: extracted.stats.headerFooterLinesRemoved,
    durationMs: Date.now() - t,
  }
  reporter.end('ocr', `${extracted.pageCount} page(s), ${extracted.ocrModel}`)
  if (extracted.pages.every((p) => p.markdown.trim() === '')) {
    reporter.warn('ocr', `No text could be extracted from ${doc.name}.`)
  }
  throwIfAborted(signal)

  // ── Heading normalisation ──────────────────────────────────────────────
  let markdown = extracted.markdown
  let structureStage: Manifest['stages']['structure'] = null
  if (config.models.structure) {
    t = Date.now()
    reporter.start('structure', config.models.structure)
    const fixed = await fixHeadings(markdown, {
      llm: registry.llm(config.models.structure),
      cache,
      reporter,
      signal,
    })
    markdown = fixed.markdown
    byStage.structure = fixed.usage
    structureStage = {
      model: config.models.structure,
      headings: fixed.headings,
      corrections: fixed.corrections,
      documentType: fixed.documentType,
      skipped: fixed.skipped,
      cached: fixed.cached,
      durationMs: Date.now() - t,
    }
    reporter.end(
      'structure',
      fixed.skipped ? `skipped: ${fixed.skipped}` : `${fixed.corrections} correction(s)`,
    )
  } else {
    reporter.end('structure', 'no model', true)
  }
  throwIfAborted(signal)

  // ── Chunking ───────────────────────────────────────────────────────────
  t = Date.now()
  reporter.start('chunk')
  const chunked: ChunkResult = chunkMarkdownDocument(markdown, config.chunk)
  for (const w of chunked.warnings) reporter.warn('chunk', w)
  const chunkMs = Date.now() - t
  reporter.end('chunk', `${chunked.chunks.length} chunk(s)`)

  // ── Context ────────────────────────────────────────────────────────────
  let summaries: string[] | undefined
  let contextStage: Manifest['stages']['context'] = null
  if (config.models.context && chunked.chunks.length > 0) {
    t = Date.now()
    reporter.start('context', config.models.context)
    const res = await enrichChunks(
      { markdown, chunks: chunked.chunks, sections: chunked.sections },
      {
        llm: registry.llm(config.models.context),
        strategy: config.context.strategy,
        batchSize: config.context.batchSize,
        concurrency: config.context.concurrency,
        cache,
        reporter,
        signal,
      },
    )
    summaries = res.summaries
    byStage.context = res.usage
    contextStage = {
      model: config.models.context,
      strategy: res.strategy,
      enriched: res.enriched,
      skipped: res.skipped,
      failed: res.failed,
      cached: res.cached,
      durationMs: Date.now() - t,
    }
    reporter.end('context', `${res.enriched} enriched (${res.strategy})`)
  } else {
    reporter.end('context', 'no model', true)
  }
  throwIfAborted(signal)

  const pageSources = new Map(extracted.pages.map((p) => [p.pageNumber, p.source]))
  const chunks = finalizeChunks({
    drafts: chunked.chunks,
    documentId: doc.documentId,
    source: doc.name,
    pageSources,
    defaultSource: extracted.pages[0]?.source ?? doc.kind,
    contextSummaries: summaries,
    countTokens: (text) => tok.count(text),
  })

  // ── Embeddings ─────────────────────────────────────────────────────────
  let embeddingStage: Manifest['stages']['embedding'] = null
  if (config.models.embedding && chunks.length > 0) {
    t = Date.now()
    reporter.start('embedding', config.models.embedding)
    const res = await embedTexts(
      chunks.map((c) => c.content),
      {
        embedder: registry.embedder(config.models.embedding),
        kind: 'document',
        cache,
        dimensions: config.embedding.dimensions,
        reporter,
        signal,
      },
    )
    res.vectors.forEach((v, i) => {
      ;(chunks[i] as Chunk).embedding = v
    })
    byStage.embedding = res.usage
    embeddingStage = {
      model: config.models.embedding,
      dimensions: res.dimensions,
      truncated: res.truncated,
      cached: res.cached,
      durationMs: Date.now() - t,
    }
    reporter.end('embedding', `${res.dimensions} dimensions`)
  } else {
    reporter.end('embedding', 'no model', true)
  }

  const structure = buildStructure(markdown, chunks, chunked.sections, extracted.pageCount)
  const total = emptyUsage()
  for (const u of Object.values(byStage)) addUsage(total, u)
  const manifest: Manifest = {
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    source: { name: doc.name, documentId: doc.documentId, kind: doc.kind, bytes: doc.bytes.length },
    config: sanitizeConfig(config),
    stages: {
      ocr: ocrStage,
      structure: structureStage,
      chunk: { tokenizer: config.chunk.tokenizer, ...chunkStats(chunks), durationMs: chunkMs },
      context: contextStage,
      embedding: embeddingStage,
    },
    usage: { total, byStage },
    warnings: reporter.warnings,
  }

  return {
    chunks,
    markdown,
    structure,
    manifest,
    warnings: reporter.warnings,
    async save(dir: string) {
      reporter.start('write', dir)
      const paths = await writeOutputs(dir, { chunks, markdown, structure, manifest })
      reporter.end('write', dir)
      return paths
    },
  }
}
