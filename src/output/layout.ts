import { type Block, parseBlocks } from '../chunker/markdown.js'
import { type Box, matchSpans, type TextSpan, unionBoxes } from '../documents/layout.js'
import type { TableData } from '../documents/tables.js'
import type { ExtractedPage } from '../ocr/extract.js'
import type { Chunk } from '../types.js'

export const LAYOUT_SCHEMA_VERSION = 1

export type LayoutBlockKind = Block['kind']

export interface LayoutBlock {
  /** `p<page>-b<n>`, unique within the document. */
  id: string
  kind: LayoutBlockKind
  /** Heading level (1-6); absent for other blocks. */
  level?: number
  /** Verbatim markdown of the block. */
  text: string
  /** Position as fractions of the page (origin top-left), null when unknown. */
  box: Box | null
  /** Layout-model class (e.g. "figure_title", "footnote") when layout analysis ran. */
  label?: string
  /** Cell structure (with spans) for tables read from a PDF text layer. */
  table?: TableData
  /** For a table that continues one from the previous page: that table's block id. */
  continues?: string
  /** Chunks that contain (part of) this block. */
  chunkIds: string[]
}

export interface LayoutPage {
  number: number
  /** Size in PDF points, null for formats without pages. */
  width: number | null
  height: number | null
  /** Engine that produced the page text. */
  source: string
  blocks: LayoutBlock[]
}

/** `document.json`: every block of the final markdown with its page, position and chunks. */
export interface DocumentLayout {
  schemaVersion: number
  documentId: string
  source: string
  pageCount: number
  pages: LayoutPage[]
}

export function buildDocumentLayout(input: {
  documentId: string
  source: string
  markdown: string
  pages: readonly ExtractedPage[]
  chunks: readonly Chunk[]
}): DocumentLayout {
  const byNumber = new Map<number, LayoutPage>()
  for (const p of input.pages) {
    byNumber.set(p.pageNumber, {
      number: p.pageNumber,
      width: p.width ?? null,
      height: p.height ?? null,
      source: p.source,
      blocks: [],
    })
  }
  const spansOf = new Map<number, readonly TextSpan[]>()
  for (const p of input.pages) if (p.spans && p.spans.length > 0) spansOf.set(p.pageNumber, p.spans)
  const chunksOnPage = (page: number) => input.chunks.filter((c) => c.pageStart <= page && page <= c.pageEnd)

  const { blocks } = parseBlocks(input.markdown, 2)
  const lastTableOnPage = new Map<number, string>()
  for (const b of blocks) {
    let page = byNumber.get(b.page)
    if (!page) {
      page = { number: b.page, width: null, height: null, source: 'unknown', blocks: [] }
      byNumber.set(b.page, page)
    }
    const spans = spansOf.get(b.page)
    const matched = spans ? matchSpans(b.text, spans) : []
    const box = spans ? unionBoxes(matched.map((s) => s.box)) : null
    const table = b.kind === 'table' ? matched.find((s) => s.table)?.table : undefined
    const label = matched.find((s) => s.label)?.label
    const chunkIds = chunksOnPage(b.page)
      .filter((c) => matchSpans(c.rawContent, [{ text: b.text }]).length > 0)
      .map((c) => c.chunkId)
    const id = `p${b.page}-b${page.blocks.length}`
    const continues = table?.continuation ? lastTableOnPage.get(b.page - 1) : undefined
    page.blocks.push({
      id,
      kind: b.kind,
      ...(b.kind === 'heading' ? { level: b.depth } : {}),
      text: b.text,
      box,
      ...(label ? { label } : {}),
      ...(table ? { table } : {}),
      ...(continues ? { continues } : {}),
      chunkIds,
    })
    if (b.kind === 'table') lastTableOnPage.set(b.page, id)
  }
  const pages = [...byNumber.values()].sort((a, b) => a.number - b.number)
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    documentId: input.documentId,
    source: input.source,
    pageCount: pages.reduce((m, p) => Math.max(m, p.number), 1),
    pages,
  }
}
