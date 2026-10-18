import { CacheStore } from '../cache/store.js'
import { type ChunkResult, chunkMarkdownDocument } from '../chunker/chunker.js'
import { finalizeChunks } from '../chunker/finalize.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import { DEFAULT_CACHE_DIR, resolveConfig } from '../config/load.js'
import type { RagChunkerConfig, ResolvedConfig } from '../config/schema.js'
import { enrichChunks } from '../context/enrich.js'
import { type DocumentInput, readDocument } from '../documents/input.js'
import { locateChunk, type TextSpan } from '../documents/layout.js'
import { embedTexts } from '../embeddings/embed.js'
import { RagChunkerError, throwIfAborted } from '../errors.js'
import { createLayoutProvider, LAYOUT_MODEL, type PageLayoutProvider } from '../local/layout.js'
import { hasModel } from '../local/models.js'
import { createOcrProvider, OCR_DET_MODEL, OCR_DICT, OCR_REC_MODEL } from '../local/ocr.js'
import { hasOnnxRuntime } from '../local/runtime.js'
import type { TableStructureProvider } from '../local/table.js'
import { createTableStructureProvider, TABLE_DICT, TABLE_MODEL } from '../local/table.js'
import { engineLabel, extractDocument, type LocalOcr, type OcrEngine } from '../ocr/extract.js'
import { buildDocumentLayout, type DocumentLayout } from '../output/layout.js'
import { chunkStats, type Manifest, PACKAGE_VERSION, sanitizeConfig } from '../output/manifest.js'
import { buildStructure, type DocumentStructure } from '../output/structure.js'
import { type OutputPaths, writeOutputs } from '../output/writer.js'
import { ProviderRegistry } from '../providers/registry.js'
import { addUsage, emptyUsage, type Usage } from '../providers/types.js'
import {
  applyHeadingLevels,
  findHeadings,
  fixHeadings,
  harmonizeNumberedHeadings,
} from '../structure/heading-fix.js'
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
  /** Every block of the document with its page, position and chunks (`document.json`). */
  layout: DocumentLayout
  manifest: Manifest
  warnings: string[]
  /** Writes chunks.jsonl, document.md, structure.json, document.json and manifest.json to `dir`. */
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
export interface OcrPlan {
  engine: OcrEngine
  pages: 'all' | 'scanned'
  /** Engine to use when an automatically chosen Mistral OCR is unusable (no quota, bad key). */
  fallback?: { engine: OcrEngine; pages: 'all' | 'scanned' }
}

/** True when onnxruntime-node and the three PP-OCR files are on this machine. */
export async function hasLocalOcr(): Promise<boolean> {
  if (!(await hasOnnxRuntime())) return false
  const present = await Promise.all([OCR_DET_MODEL, OCR_REC_MODEL, OCR_DICT].map((id) => hasModel(id)))
  return present.every(Boolean)
}

export async function resolveOcrEngine(ctx: PipelineContext): Promise<OcrPlan> {
  const { engine, pages } = ctx.config.ocr
  let resolved: OcrEngine
  if (engine === 'text-layer') resolved = { type: 'text-layer' }
  else if (engine === 'pp-ocr') {
    if (!(await hasOnnxRuntime())) {
      throw new RagChunkerError(
        'OPTIONAL_DEPENDENCY_MISSING',
        'ocr.engine is "pp-ocr" but "onnxruntime-node" is not installed',
        {
          hint: 'Install it with: npm install onnxruntime-node',
        },
      )
    }
    resolved = { type: 'local' }
  } else if (engine === 'mistral') {
    const mistral = ctx.registry.provider('mistral')
    if (!mistral.apiKey) {
      throw new RagChunkerError('MISSING_API_KEY', 'ocr.engine is "mistral" but no Mistral API key is set', {
        hint: 'Set MISTRAL_API_KEY in your environment or .env file.',
      })
    }
    resolved = { type: 'mistral' }
  } else if (engine === 'auto') {
    const vision = ctx.config.models.vision
    if (await hasLocalOcr()) resolved = { type: 'local' }
    else if (ctx.registry.provider('mistral').apiKey) resolved = { type: 'mistral' }
    else if (vision) resolved = { type: 'vision', ref: vision }
    else resolved = { type: 'text-layer' }
  } else {
    resolved = { type: 'vision', ref: engine }
  }
  const mode = pages === 'auto' ? (resolved.type === 'mistral' ? 'all' : 'scanned') : pages
  // An automatically chosen engine that turns out unusable hands over to the next one in line.
  if (engine === 'auto' && (resolved.type === 'mistral' || resolved.type === 'local')) {
    const vision = ctx.config.models.vision
    const fallback: OcrEngine =
      resolved.type === 'local' && ctx.registry.provider('mistral').apiKey
        ? { type: 'mistral' }
        : vision
          ? { type: 'vision', ref: vision }
          : { type: 'text-layer' }
    const fallbackPages = pages === 'auto' ? (fallback.type === 'mistral' ? 'all' : 'scanned') : pages
    return { engine: resolved, pages: mode, fallback: { engine: fallback, pages: fallbackPages } }
  }
  return { engine: resolved, pages: mode }
}

/** Errors that make an automatically chosen OCR engine unusable; "auto" then moves on to the next one. */
const OCR_FALLBACK_CODES = new Set([
  'QUOTA_EXCEEDED',
  'MISSING_API_KEY',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
])

const engineName = engineLabel
/** How an engine is called in warnings. */
function engineTitle(engine: OcrEngine): string {
  if (engine.type === 'mistral') return 'Mistral OCR'
  if (engine.type === 'local') return 'Local OCR (PP-OCR)'
  if (engine.type === 'vision') return engine.ref
  return 'the text layer'
}

export interface LayoutPlan {
  /** Model that will analyse PDF pages, or null. */
  engine: string | null
  /** Why "auto" stays off: what is missing. */
  reason?: string
  /** True when the model file still has to be downloaded. */
  download?: boolean
}

/**
 * Whether PDF pages get layout analysis: "off" never, "pp-doclayout-v3" always (downloading the
 * model on first use), "auto" only when the runtime and the model are already on the machine.
 */
export async function resolveLayout(config: ResolvedConfig): Promise<LayoutPlan> {
  const { engine } = config.layout
  if (engine === 'off') return { engine: null }
  const runtime = await hasOnnxRuntime()
  const present = await Promise.all([LAYOUT_MODEL, TABLE_MODEL, TABLE_DICT].map((id) => hasModel(id)))
  const model = present.every(Boolean)
  if (engine === 'pp-doclayout-v3') {
    if (!runtime) {
      throw new RagChunkerError(
        'OPTIONAL_DEPENDENCY_MISSING',
        'Layout analysis needs the "onnxruntime-node" package',
        {
          hint: 'Install it with: npm install onnxruntime-node  (or set layout.engine to "off")',
        },
      )
    }
    return { engine: LAYOUT_MODEL, download: !model }
  }
  if (runtime && model) return { engine: LAYOUT_MODEL }
  return {
    engine: null,
    reason: !runtime
      ? 'onnxruntime-node is not installed'
      : 'the layout model is not downloaded (run once with --layout)',
  }
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
  const plan = await resolveOcrEngine(ctx)
  let { engine } = plan
  let t = Date.now()
  reporter.start('ocr', engineName(engine))
  const mb = (n: number) => Math.round(n / 1024 / 1024)
  let localOcr: LocalOcr | undefined
  if (engine.type === 'local') {
    try {
      localOcr = await createOcrProvider({
        cache,
        documentId: doc.documentId,
        onModelDownload: (file, done, total) =>
          reporter.progress('ocr', mb(done), mb(total), `downloading ${file} (MB)`),
        signal,
      })
    } catch (err) {
      if (!plan.fallback || !(err instanceof RagChunkerError) || !OCR_FALLBACK_CODES.has(err.code)) throw err
      reporter.warn(
        'ocr',
        `Local OCR (PP-OCR) is not usable (${err.message}); using ${engineTitle(plan.fallback.engine)} instead. ${err.hint ?? ''}`.trim(),
      )
      engine = plan.fallback.engine
      plan.pages = plan.fallback.pages
      plan.fallback = undefined
    }
  }
  let layoutProvider: PageLayoutProvider | undefined
  let tableProvider: TableStructureProvider | undefined
  const layoutPlan =
    doc.kind === 'pdf' || doc.kind === 'image' ? await resolveLayout(config) : { engine: null }
  if (layoutPlan.engine) {
    tableProvider = await createTableStructureProvider({
      cache,
      documentId: doc.documentId,
      onModelDownload: (file, done, total) =>
        reporter.progress('ocr', mb(done), mb(total), `downloading ${file} (MB)`),
      signal,
    })
    layoutProvider = await createLayoutProvider({
      render: config.layout.render,
      minScore: config.layout.minScore,
      cache,
      documentId: doc.documentId,
      onModelDownload: (done, total) =>
        reporter.progress('ocr', mb(done), mb(total), 'downloading PP-DocLayoutV3 (MB)'),
      onPage: (page, total) => reporter.progress('ocr', page, total, 'layout'),
      signal,
    })
  }
  const extract = (e: OcrEngine, p: 'all' | 'scanned') =>
    extractDocument(doc, {
      engine: e,
      pages: p,
      minTextChars: config.ocr.minTextChars,
      stripImages: config.ocr.stripImages,
      removeHeaderFooter: config.ocr.removeHeaderFooter,
      concurrency: config.ocr.concurrency,
      layout: layoutProvider,
      tables: tableProvider,
      localOcr,
      registry,
      cache,
      reporter,
      signal,
    })
  let extracted: Awaited<ReturnType<typeof extractDocument>>
  try {
    extracted = await extract(engine, plan.pages)
  } catch (err) {
    if (!plan.fallback || !(err instanceof RagChunkerError) || !OCR_FALLBACK_CODES.has(err.code)) throw err
    reporter.warn(
      'ocr',
      `${engineTitle(engine)} is not usable (${err.message}); using ${engineTitle(plan.fallback.engine)} instead. ${err.hint ?? ''}`.trim(),
    )
    engine = plan.fallback.engine
    extracted = await extract(engine, plan.fallback.pages)
  }
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
    layout: layoutPlan.engine,
    layoutPages: extracted.stats.layoutPages,
    durationMs: Date.now() - t,
  }
  reporter.end(
    'ocr',
    `${extracted.pageCount} page(s), ${extracted.ocrModel}${layoutPlan.engine ? ' + layout' : ''}`,
  )
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
    // Free deterministic pass: numbered headings of the same depth get the same level.
    const headings = findHeadings(markdown)
    const changes = harmonizeNumberedHeadings(headings, new Map())
    if (changes.size > 0) markdown = applyHeadingLevels(markdown, changes, headings)
    reporter.end(
      'structure',
      changes.size > 0 ? `${changes.size} numbered heading(s) aligned (no model)` : 'no model',
      true,
    )
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
  // Text-layer pages know where each paragraph sits; chunks inherit those boxes.
  const spansByPage = new Map<number, readonly TextSpan[]>()
  for (const p of extracted.pages) if (p.spans && p.spans.length > 0) spansByPage.set(p.pageNumber, p.spans)
  for (const c of chunks) c.boxes = locateChunk(c, spansByPage)

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
  const layout = buildDocumentLayout({
    documentId: doc.documentId,
    source: doc.name,
    markdown,
    pages: extracted.pages,
    chunks,
  })
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
    layout,
    manifest,
    warnings: reporter.warnings,
    async save(dir: string) {
      reporter.start('write', dir)
      const paths = await writeOutputs(dir, { chunks, markdown, structure, layout, manifest })
      reporter.end('write', dir)
      return paths
    },
  }
}
