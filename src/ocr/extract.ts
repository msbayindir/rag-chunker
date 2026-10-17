import type { CacheStore } from '../cache/store.js'
import { docxToMarkdown } from '../documents/docx.js'
import type { DocumentInput } from '../documents/input.js'
import { PdfDocumentHandle, planPageBatches, subsetPdf } from '../documents/pdf.js'
import { pptxToMarkdown } from '../documents/pptx.js'
import { RagChunkerError, throwIfAborted } from '../errors.js'
import type { Reporter } from '../pipeline/events.js'
import {
  MISTRAL_MAX_BYTES,
  MISTRAL_MAX_PAGES,
  MISTRAL_OCR_MODEL,
  mistralOcr,
} from '../providers/mistral-ocr.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { addUsage, emptyUsage, type Usage } from '../providers/types.js'
import { mapPool } from '../util/async.js'
import { cleanPageMarkdown, joinPages, removeRepeatedHeaderFooter, splitPages } from './postprocess.js'
import { VISION_PROMPT_VERSION, visionOcrPage } from './vision.js'

const OCR_CACHE_VERSION = 1

export type OcrEngine = { type: 'text-layer' } | { type: 'mistral' } | { type: 'vision'; ref: string }

export interface ExtractOptions {
  engine: OcrEngine
  /** Which PDF pages go to the OCR engine; the rest use the text layer. */
  pages: 'all' | 'scanned'
  minTextChars: number
  stripImages: boolean
  removeHeaderFooter: boolean
  concurrency?: number
  registry: ProviderRegistry
  cache: CacheStore
  reporter: Reporter
  signal?: AbortSignal
}

export interface ExtractedPage {
  pageNumber: number
  markdown: string
  /** text-layer | mistral | <provider/model> | markdown | docx | pptx */
  source: string
}

export interface ExtractStats {
  pages: number
  textLayerPages: number
  ocrPages: number
  cachedPages: number
  scannedPages: number
  emptyPages: number
  headerFooterLinesRemoved: number
}

export interface ExtractResult {
  markdown: string
  pages: ExtractedPage[]
  pageCount: number
  /** Engines used, e.g. "text-layer+mistral-ocr-latest". */
  ocrModel: string
  stats: ExtractStats
  usage: Usage
}

function engineLabel(engine: OcrEngine): string {
  return engine.type === 'vision' ? engine.ref : engine.type
}

function needsOcrHint(): string {
  return 'Set MISTRAL_API_KEY, pass --local (Ollama vision model) or --ocr <provider/model>.'
}

/** Reads any supported document into page markdown using the configured OCR engine. */
export async function extractDocument(doc: DocumentInput, opts: ExtractOptions): Promise<ExtractResult> {
  const usage = emptyUsage()
  const stats: ExtractStats = {
    pages: 0,
    textLayerPages: 0,
    ocrPages: 0,
    cachedPages: 0,
    scannedPages: 0,
    emptyPages: 0,
    headerFooterLinesRemoved: 0,
  }
  let pages: ExtractedPage[]

  switch (doc.kind) {
    case 'markdown': {
      const text = new TextDecoder('utf-8').decode(doc.bytes).replace(/^﻿/, '')
      pages = splitPages(text).map((p) => ({ ...p, source: 'markdown' }))
      break
    }
    case 'docx': {
      const { markdown, warnings } = await docxToMarkdown(doc.bytes)
      for (const w of warnings) opts.reporter.warn('ocr', w)
      pages = [{ pageNumber: 1, markdown, source: 'docx' }]
      break
    }
    case 'pptx': {
      const { markdown } = await pptxToMarkdown(doc.bytes)
      pages = splitPages(markdown).map((p) => ({ ...p, source: 'pptx' }))
      break
    }
    case 'image':
      pages = [await ocrImage(doc, opts, usage, stats)]
      break
    case 'pdf':
      pages = await extractPdf(doc, opts, usage, stats)
      break
  }

  if (doc.kind === 'pdf' || doc.kind === 'image') {
    pages = pages.map((p) => ({
      ...p,
      markdown: cleanPageMarkdown(p.markdown, { stripImages: opts.stripImages }),
    }))
    if (opts.removeHeaderFooter && pages.length >= 3) {
      const res = removeRepeatedHeaderFooter(pages.map((p) => p.markdown))
      stats.headerFooterLinesRemoved = res.removed
      pages = pages.map((p, i) => ({ ...p, markdown: res.pages[i] as string }))
    }
  }

  stats.pages = pages.length
  stats.emptyPages = pages.filter((p) => p.markdown.trim() === '').length
  const sources = [...new Set(pages.map((p) => p.source))]
  return {
    markdown: joinPages(pages),
    pages,
    pageCount: pages.reduce((max, p) => Math.max(max, p.pageNumber), 1),
    ocrModel: sources.map((s) => (s === 'mistral' ? MISTRAL_OCR_MODEL : s)).join('+'),
    stats,
    usage,
  }
}

async function ocrImage(
  doc: DocumentInput,
  opts: ExtractOptions,
  usage: Usage,
  stats: ExtractStats,
): Promise<ExtractedPage> {
  const engine = opts.engine
  if (engine.type === 'text-layer') {
    throw new RagChunkerError('UNSUPPORTED_INPUT', `${doc.name} is an image and needs an OCR engine`, {
      hint: needsOcrHint(),
    })
  }
  const label = engineLabel(engine)
  const key = opts.cache.key('ocr', OCR_CACHE_VERSION, doc.documentId, 1, label, VISION_PROMPT_VERSION)
  const cached = await opts.cache.get<string>('ocr', key)
  if (cached !== undefined) {
    stats.cachedPages++
    return { pageNumber: 1, markdown: cached, source: label }
  }
  opts.reporter.progress('ocr', 0, 1, label)
  let markdown: string
  if (engine.type === 'mistral') {
    const res = await mistralOcr({
      provider: opts.registry.provider('mistral'),
      bytes: doc.bytes,
      mime: doc.mime,
      kind: 'image',
      signal: opts.signal,
    })
    markdown = res.pages.map((p) => p.markdown).join('\n\n')
    addUsage(usage, { requests: 1 })
  } else {
    const llm = opts.registry.llm(engine.ref)
    await assertVision(llm.ref, llm.capabilities())
    const res = await visionOcrPage(llm, doc.bytes, doc.mime, opts.signal)
    markdown = res.markdown
    addUsage(usage, res.usage)
  }
  stats.ocrPages++
  await opts.cache.set('ocr', key, markdown)
  opts.reporter.progress('ocr', 1, 1, label)
  return { pageNumber: 1, markdown, source: label }
}

async function assertVision(ref: string, caps: Promise<{ vision: boolean }>): Promise<void> {
  if (!(await caps).vision) {
    throw new RagChunkerError('CAPABILITY_MISSING', `${ref} cannot read images`, {
      hint: 'Pick a vision model, e.g. ollama/gemma4:e4b-it-qat or gemini/gemini-3.8-flash.',
    })
  }
}

async function extractPdf(
  doc: DocumentInput,
  opts: ExtractOptions,
  usage: Usage,
  stats: ExtractStats,
): Promise<ExtractedPage[]> {
  const handle = await PdfDocumentHandle.open(doc.bytes)
  try {
    const textPages = await handle.textLayer()
    const scanned = textPages.filter((p) => p.chars < opts.minTextChars || p.garbled).map((p) => p.pageNumber)
    stats.scannedPages = scanned.length
    const engine = opts.engine
    const all = textPages.map((p) => p.pageNumber)
    const targets = engine.type === 'text-layer' ? [] : opts.pages === 'all' ? all : scanned
    const targetSet = new Set(targets)
    const label = engineLabel(engine)
    const result = new Map<number, ExtractedPage>()

    for (const p of textPages) {
      if (!targetSet.has(p.pageNumber)) {
        result.set(p.pageNumber, { pageNumber: p.pageNumber, markdown: p.markdown, source: 'text-layer' })
        stats.textLayerPages++
      }
    }
    if (engine.type === 'text-layer' && scanned.length > 0) {
      opts.reporter.warn(
        'ocr',
        `${scanned.length} page(s) have no usable text layer (scanned?): ${scanned.slice(0, 10).join(', ')}${scanned.length > 10 ? '…' : ''}. ${needsOcrHint()}`,
      )
    }

    // Serve what we can from the page cache.
    const keyOf = (page: number) =>
      opts.cache.key(
        'ocr',
        OCR_CACHE_VERSION,
        doc.documentId,
        page,
        label,
        engine.type === 'vision' ? VISION_PROMPT_VERSION : 0,
      )
    const pending: number[] = []
    for (const page of targets) {
      const cached = await opts.cache.get<string>('ocr', keyOf(page))
      if (cached !== undefined) {
        result.set(page, { pageNumber: page, markdown: cached, source: label })
        stats.cachedPages++
      } else {
        pending.push(page)
      }
    }

    let done = targets.length - pending.length
    const total = targets.length
    if (total > 0) opts.reporter.progress('ocr', done, total, label)

    if (pending.length > 0 && engine.type === 'mistral') {
      const provider = opts.registry.provider('mistral')
      const groups = planPageBatches(
        pending,
        doc.bytes.length,
        handle.pageCount,
        MISTRAL_MAX_BYTES,
        MISTRAL_MAX_PAGES,
      )
      await mapPool(
        groups,
        provider.concurrency,
        async (group) => {
          throwIfAborted(opts.signal)
          let res: Awaited<ReturnType<typeof mistralOcr>>
          let pageOf: (index: number) => number
          try {
            const subset = await subsetPdf(doc.bytes, group)
            res = await mistralOcr({
              provider,
              bytes: subset,
              mime: doc.mime,
              kind: 'pdf',
              signal: opts.signal,
            })
            pageOf = (i) => group[i] as number
          } catch (err) {
            if (err instanceof RagChunkerError) throw err
            // pdf-lib could not rewrite the file (e.g. encryption): send it whole with a page filter.
            res = await mistralOcr({
              provider,
              bytes: doc.bytes,
              mime: doc.mime,
              kind: 'pdf',
              pages: group.map((p) => p - 1),
              signal: opts.signal,
            })
            pageOf = (i) => i + 1
          }
          const byPage = new Map<number, string>()
          for (const p of res.pages) byPage.set(pageOf(p.index), p.markdown)
          for (const page of group) {
            const markdown = byPage.get(page) ?? ''
            result.set(page, { pageNumber: page, markdown, source: label })
            await opts.cache.set('ocr', keyOf(page), markdown)
          }
          addUsage(usage, { requests: 1 })
          stats.ocrPages += group.length
          done += group.length
          opts.reporter.progress('ocr', done, total, label)
        },
        opts.signal,
      )
    }

    if (pending.length > 0 && engine.type === 'vision') {
      const llm = opts.registry.llm(engine.ref)
      await assertVision(llm.ref, llm.capabilities())
      await mapPool(
        pending,
        opts.concurrency ?? llm.provider.concurrency,
        async (page) => {
          const png = await handle.renderPng(page)
          const res = await visionOcrPage(llm, png, 'image/png', opts.signal)
          addUsage(usage, res.usage)
          result.set(page, { pageNumber: page, markdown: res.markdown, source: label })
          await opts.cache.set('ocr', keyOf(page), res.markdown)
          stats.ocrPages++
          done++
          opts.reporter.progress('ocr', done, total, label)
        },
        opts.signal,
      )
    }

    return all.map((p) => result.get(p) ?? { pageNumber: p, markdown: '', source: 'text-layer' })
  } finally {
    await handle.close()
  }
}
