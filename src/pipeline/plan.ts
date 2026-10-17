import { chunkMarkdownDocument } from '../chunker/chunker.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import type { RagChunkerConfig } from '../config/schema.js'
import { isLowQuality } from '../context/enrich.js'
import { readDocument } from '../documents/input.js'
import { extractDocument } from '../ocr/extract.js'
import { Reporter } from './events.js'
import { createContext, type ProcessOptions, resolveOcrEngine } from './process.js'

export interface PlanReport {
  source: { name: string; kind: string; bytes: number }
  pages: number
  scannedPages: number
  ocr: { engine: string; pagesToOcr: number }
  documentTokens: number
  estimatedChunks: number
  structure: { model: string } | null
  context: {
    model: string
    estimatedRequests: number
    /** Upper bound without prompt caching when the whole document fits the model ("full" strategy). */
    fullStrategyInputTokens: number
  } | null
  embedding: { model: string; texts: number } | null
  warnings: string[]
}

/**
 * Dry run: reads the document locally (text layer only, no provider calls) and reports what a real
 * run would do. Token figures are estimates; scanned pages are not counted until they are OCR'd.
 */
export async function planDocument(
  input: string | Uint8Array,
  config: RagChunkerConfig = {},
  options: Pick<ProcessOptions, 'name' | 'env'> = {},
): Promise<PlanReport> {
  const ctx = createContext({ ...config, cache: { enabled: false } }, options.env)
  const doc = await readDocument(input, options.name)
  const { engine, pages } = resolveOcrEngine(ctx)
  const reporter = new Reporter()
  const warnings: string[] = []

  let markdown = ''
  let pageCount = 1
  let scanned = 0
  if (doc.kind === 'image') {
    warnings.push('Images are always OCR’d; text is unknown until then.')
  } else {
    const extracted = await extractDocument(doc, {
      engine: { type: 'text-layer' },
      pages: 'scanned',
      minTextChars: ctx.config.ocr.minTextChars,
      stripImages: ctx.config.ocr.stripImages,
      removeHeaderFooter: ctx.config.ocr.removeHeaderFooter,
      registry: ctx.registry,
      cache: ctx.cache,
      reporter,
    })
    markdown = extracted.markdown
    pageCount = extracted.pageCount
    scanned = extracted.stats.scannedPages
  }
  const pagesToOcr =
    doc.kind === 'image'
      ? engine.type === 'text-layer'
        ? 0
        : 1
      : doc.kind !== 'pdf' || engine.type === 'text-layer'
        ? 0
        : pages === 'all'
          ? pageCount
          : scanned
  if (engine.type === 'text-layer' && scanned > 0) {
    warnings.push(`${scanned} scanned page(s) will have no text without an OCR engine.`)
  }

  const tok = getTokenizer(ctx.config.chunk.tokenizer)
  const documentTokens = tok.count(markdown.replace(/<!--\s*page\s+\d+\s*-->/gi, ''))
  const { chunks } = chunkMarkdownDocument(markdown, ctx.config.chunk)
  const eligible = chunks.filter((c) => c.mustPreserve || !isLowQuality(c.text)).length
  const requests = Math.ceil(eligible / ctx.config.context.batchSize)
  const { models } = ctx.config

  return {
    source: { name: doc.name, kind: doc.kind, bytes: doc.bytes.length },
    pages: pageCount,
    scannedPages: scanned,
    ocr: { engine: engine.type === 'vision' ? engine.ref : engine.type, pagesToOcr },
    documentTokens,
    estimatedChunks: chunks.length,
    structure: models.structure ? { model: models.structure } : null,
    context: models.context
      ? {
          model: models.context,
          estimatedRequests: requests,
          fullStrategyInputTokens:
            requests * (documentTokens + ctx.config.context.batchSize * ctx.config.chunk.maxTokens),
        }
      : null,
    embedding: models.embedding ? { model: models.embedding, texts: chunks.length } : null,
    warnings: [...warnings, ...reporter.warnings],
  }
}
