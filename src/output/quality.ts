import type { Chunk } from '../types.js'
import type { DocumentLayout, LayoutBlock } from './layout.js'
import type { Manifest } from './manifest.js'

/**
 * Quality signals of one processed document, computed from what the pipeline produced: where text
 * came from and how sure OCR was, whether blocks read like text, how headings, tables, figures and
 * chunks came out. `flags` says in plain words what deserves a look.
 */
export interface QualityReport {
  pages: { total: number; textLayer: number; ocr: number; empty: number }
  /** Blocks read by local OCR and their confidence; null when no OCR confidence exists. */
  ocr: { blocks: number; meanConfidence: number; lowConfidenceBlocks: number } | null
  text: { blocks: number; letterShare: number; garbledBlocks: number }
  headings: { count: number; maxDepth: number; long: number; levelJumps: number }
  tables: { count: number; bySource: Record<string, number>; sparse: number; continued: number }
  figures: { count: number; captioned: number; described: number }
  chunks: {
    count: number
    located: number
    small: number
    large: number
    withContext: number
    withEmbedding: number
  }
  /** Findings worth a look, most important first; empty when nothing stands out. */
  flags: string[]
}

const LOW_CONFIDENCE = 0.6
const LONG_HEADING = 120
const SPARSE_TABLE = 0.4
const TEXT_SOURCES = new Set(['text-layer', 'markdown', 'docx', 'pptx', 'xlsx', 'html'])

const letterShareOf = (text: string): number => {
  const visible = text.replace(/\s+/g, '')
  if (visible.length === 0) return 1
  const letters = (visible.match(/\p{L}/gu) ?? []).length
  return letters / visible.length
}

const pct = (part: number, whole: number) => `${Math.round((100 * part) / Math.max(1, whole))} %`

export function assessQuality(input: {
  layout: DocumentLayout
  chunks: readonly Chunk[]
  stages: Pick<Manifest['stages'], 'ocr'>
  chunk: { minTokens: number; maxTokens: number }
  kind: string
}): QualityReport {
  const pages = input.layout.pages
  const blocks: LayoutBlock[] = pages.flatMap((p) => p.blocks)
  const paged = input.kind === 'pdf' || input.kind === 'image'

  const ocrBlocks = blocks.filter((b) => b.confidence !== undefined)
  const ocr =
    ocrBlocks.length > 0
      ? {
          blocks: ocrBlocks.length,
          meanConfidence:
            Math.round(
              (ocrBlocks.reduce((s, b) => s + (b.confidence as number), 0) / ocrBlocks.length) * 1000,
            ) / 1000,
          lowConfidenceBlocks: ocrBlocks.filter((b) => (b.confidence as number) < LOW_CONFIDENCE).length,
        }
      : null

  const prose = blocks.filter((b) => b.kind === 'text' || b.kind === 'list')
  const garbled = prose.filter((b) => b.text.replace(/\s+/g, '').length >= 40 && letterShareOf(b.text) < 0.5)
  const allText = prose.map((b) => b.text).join('\n')

  const headings = blocks.filter((b) => b.kind === 'heading')
  let levelJumps = 0
  let prevLevel = 0
  for (const h of headings) {
    const level = h.level ?? 1
    if (prevLevel > 0 && level > prevLevel + 1) levelJumps++
    prevLevel = level
  }

  const tables = blocks.filter((b) => b.kind === 'table')
  const bySource: Record<string, number> = {}
  let sparse = 0
  for (const t of tables) {
    const source = t.table?.source ?? 'markdown'
    bySource[source] = (bySource[source] ?? 0) + 1
    const cells = t.table?.cells ?? []
    if (cells.length >= 4 && cells.filter((c) => c.text === '').length / cells.length > SPARSE_TABLE) sparse++
  }

  const figures = blocks.filter((b) => b.kind === 'figure')
  const chunks = input.chunks

  const report: QualityReport = {
    pages: {
      total: input.layout.pageCount,
      textLayer: pages.filter((p) => p.source === 'text-layer').length,
      ocr: pages.filter((p) => !TEXT_SOURCES.has(p.source) && p.source !== 'unknown').length,
      empty: paged ? pages.filter((p) => p.blocks.length === 0).length : 0,
    },
    ocr,
    text: {
      blocks: prose.length,
      letterShare: Math.round(letterShareOf(allText) * 1000) / 1000,
      garbledBlocks: garbled.length,
    },
    headings: {
      count: headings.length,
      maxDepth: headings.reduce((m, h) => Math.max(m, h.level ?? 1), 0),
      long: headings.filter((h) => h.text.length > LONG_HEADING).length,
      levelJumps,
    },
    tables: { count: tables.length, bySource, sparse, continued: tables.filter((t) => t.continues).length },
    figures: {
      count: figures.length,
      captioned: figures.filter((f) => f.figure?.caption).length,
      described: figures.filter((f) => f.figure?.description).length,
    },
    chunks: {
      count: chunks.length,
      located: chunks.filter((c) => c.boxes.length > 0).length,
      small: chunks.filter((c) => c.tokenCount < input.chunk.minTokens).length,
      large: chunks.filter((c) => c.tokenCount > input.chunk.maxTokens).length,
      withContext: chunks.filter((c) => c.contextSummary !== '').length,
      withEmbedding: chunks.filter((c) => c.embedding.length > 0).length,
    },
    flags: [],
  }

  const flags = report.flags
  if (report.pages.empty > 0) {
    flags.push(
      `${report.pages.empty} page(s) without text${
        input.stages.ocr.ocrPages === 0
          ? ' — scanned pages need an OCR engine (--ocr pp-ocr, --local or a key)'
          : ''
      }`,
    )
  }
  if (ocr && ocr.lowConfidenceBlocks / ocr.blocks > 0.1) {
    flags.push(
      `${ocr.lowConfidenceBlocks} of ${ocr.blocks} OCR blocks (${pct(ocr.lowConfidenceBlocks, ocr.blocks)}) below ${LOW_CONFIDENCE} confidence — check the scan quality or try another OCR engine`,
    )
  }
  if (garbled.length > 0) {
    flags.push(
      `${garbled.length} block(s) with few letters (broken text layer or OCR noise), e.g. page ${pages.find((p) => p.blocks.includes(garbled[0] as LayoutBlock))?.number ?? '?'}`,
    )
  }
  if (sparse > 0) flags.push(`${sparse} table(s) with mostly empty cells — columns may be split wrong`)
  if (report.headings.long > 0)
    flags.push(
      `${report.headings.long} heading(s) longer than ${LONG_HEADING} characters — probably body text`,
    )
  if (levelJumps > 0) flags.push(`heading levels skip a level ${levelJumps} time(s)`)
  if (report.chunks.large > 0)
    flags.push(`${report.chunks.large} chunk(s) above maxTokens (long table rows or code lines)`)
  if (chunks.length >= 10 && report.chunks.small / chunks.length > 0.1) {
    flags.push(`${report.chunks.small} chunk(s) (${pct(report.chunks.small, chunks.length)}) below minTokens`)
  }
  if (
    paged &&
    report.pages.textLayer > 0 &&
    chunks.length > 0 &&
    report.chunks.located / chunks.length < 0.5
  ) {
    flags.push(`positions known for only ${pct(report.chunks.located, chunks.length)} of the chunks`)
  }
  if (figures.length > 0 && report.figures.captioned < figures.length) {
    flags.push(
      `${figures.length - report.figures.captioned} of ${figures.length} figure(s) without a caption`,
    )
  }
  return report
}
