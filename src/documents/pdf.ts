import { PDFDocument } from 'pdf-lib'
import { extractTextItems, getDocumentProxy, renderPageAsImage, type StructuredTextItem } from 'unpdf'
import { RagChunkerError } from '../errors.js'
import { importOptional } from '../util/optional.js'

export interface PdfTextPage {
  pageNumber: number
  markdown: string
  /** Non-whitespace characters on the page. */
  chars: number
  /** True when the text layer looks broken (missing ToUnicode maps, private-use glyphs…). */
  garbled: boolean
}

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>

interface Line {
  text: string
  y: number
  x0: number
  x1: number
  size: number
}

const LIST_RE = /^([•◦▪●○■□▶►‣⁃·*–-]|\(?\d{1,3}[.)]|[a-zçğıöşü][.)])\s+/u
const BULLET_RE = /^[•◦▪●○■□▶►‣⁃·*–-]\s+/u

/** Opens a PDF once for text extraction and page rendering. Call `close()` when done. */
export class PdfDocumentHandle {
  private constructor(
    private readonly proxy: PdfProxy,
    readonly pageCount: number,
  ) {}

  static async open(bytes: Uint8Array): Promise<PdfDocumentHandle> {
    let proxy: PdfProxy
    try {
      // pdf.js may transfer (detach) the buffer it is given, so always pass a copy.
      proxy = await getDocumentProxy(new Uint8Array(bytes))
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      if (/password/i.test(message)) {
        throw new RagChunkerError('INPUT_INVALID', 'The PDF is password protected', {
          hint: 'Remove the password (for example with qpdf --decrypt) and try again.',
          cause: err,
        })
      }
      throw new RagChunkerError('INPUT_INVALID', `Could not read PDF: ${message}`, { cause: err })
    }
    return new PdfDocumentHandle(proxy, proxy.numPages)
  }

  async pageSize(pageNumber: number): Promise<{ width: number; height: number }> {
    const page = await this.proxy.getPage(pageNumber)
    const vp = page.getViewport({ scale: 1 })
    return { width: vp.width, height: vp.height }
  }

  /** Converts the text layer of every page into markdown with inferred headings, paragraphs and lists. */
  async textLayer(): Promise<PdfTextPage[]> {
    const { items } = await extractTextItems(this.proxy)
    const pages: Array<{
      pageNumber: number
      lines: Line[]
      width: number
      chars: number
      garbled: boolean
    }> = []
    for (let i = 0; i < items.length; i++) {
      const pageItems = items[i] ?? []
      const { width } = await this.pageSize(i + 1)
      const raw = pageItems.map((it) => it.str).join('')
      const chars = raw.replace(/\s+/g, '').length
      pages.push({
        pageNumber: i + 1,
        lines: orderColumns(toLines(pageItems), width),
        width,
        chars,
        garbled: isGarbled(raw),
      })
    }
    const all = pages.flatMap((p) => p.lines)
    const body = bodyFontSize(all)
    const headingLevels = headingSizes(all, body)
    const lineGap = typicalLineGap(
      pages.map((p) => p.lines),
      body,
    )
    return pages.map((p) => ({
      pageNumber: p.pageNumber,
      markdown: linesToMarkdown(p.lines, body, headingLevels, lineGap),
      chars: p.chars,
      garbled: p.garbled,
    }))
  }

  /** Renders a page to PNG with its longer side at `longSide` pixels. Needs @napi-rs/canvas. */
  async renderPng(pageNumber: number, longSide = 1536): Promise<Uint8Array> {
    const canvas = await importOptional(
      '@napi-rs/canvas',
      'Rendering PDF pages for vision OCR',
      () => import('@napi-rs/canvas'),
    )
    const { width, height } = await this.pageSize(pageNumber)
    const scale = Math.min(4, Math.max(0.5, longSide / Math.max(width, height)))
    const png = await renderPageAsImage(this.proxy, pageNumber, { canvasImport: async () => canvas, scale })
    return new Uint8Array(png)
  }

  async close(): Promise<void> {
    const proxy = this.proxy as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> }
    try {
      if (typeof proxy.destroy === 'function') await proxy.destroy()
      else if (typeof proxy.cleanup === 'function') await proxy.cleanup()
    } catch {
      // Releasing pdf.js resources is best effort.
    }
  }
}

function isGarbled(text: string): boolean {
  const visible = text.replace(/\s+/g, '')
  if (visible.length < 20) return false
  const bad = (visible.match(/[�-\u0000-\u0008\u000E-\u001F]/g) ?? []).length
  return bad / visible.length > 0.1
}

function toLines(items: StructuredTextItem[]): Line[] {
  const sorted = items
    .filter((it) => it.str.length > 0 && it.dir !== 'ttb')
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Array<{ items: StructuredTextItem[]; y: number }> = []
  for (const it of sorted) {
    const tolerance = Math.max(2, it.fontSize * 0.45)
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tolerance)
    if (line) line.items.push(it)
    else lines.push({ items: [it], y: it.y })
  }
  // Items on the same baseline but separated by a wide gap belong to different columns.
  const segments: StructuredTextItem[][] = []
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x)
    let current: StructuredTextItem[] = []
    let lastEnd = Number.NEGATIVE_INFINITY
    for (const it of its) {
      if (current.length > 0 && it.x - lastEnd > Math.max(it.fontSize * 1.8, 12)) {
        segments.push(current)
        current = []
      }
      current.push(it)
      lastEnd = it.x + it.width
    }
    if (current.length > 0) segments.push(current)
  }
  const out: Line[] = []
  for (const its of segments) {
    let text = ''
    let lastEnd = Number.NEGATIVE_INFINITY
    let sizeWeight = 0
    let sizeSum = 0
    for (const it of its) {
      const gap = it.x - lastEnd
      if (text !== '' && gap > it.fontSize * 0.2 && !text.endsWith(' ') && !it.str.startsWith(' '))
        text += ' '
      text += it.str
      lastEnd = it.x + it.width
      const w = it.str.trim().length
      sizeWeight += w
      sizeSum += it.fontSize * w
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const first = its[0] as StructuredTextItem
    out.push({
      text,
      y: first.y,
      x0: first.x,
      x1: lastEnd,
      size: sizeWeight > 0 ? sizeSum / sizeWeight : first.fontSize,
    })
  }
  return out.sort((a, b) => b.y - a.y || a.x0 - b.x0)
}

/** Reads two-column pages column by column instead of line by line across both columns. */
function orderColumns(lines: Line[], width: number): Line[] {
  if (lines.length < 8 || width <= 0) return lines
  const mid = width / 2
  const right = lines.filter((l) => l.x0 >= mid * 0.95)
  const leftOnly = lines.filter((l) => l.x0 < mid * 0.95 && l.x1 <= mid * 1.1)
  if (right.length < lines.length * 0.25 || leftOnly.length < lines.length * 0.25) return lines
  const left = lines.filter((l) => l.x0 < mid * 0.95)
  return [...left, ...right]
}

function roundSize(size: number): number {
  return Math.round(size * 2) / 2
}

function bodyFontSize(lines: Line[]): number {
  const weights = new Map<number, number>()
  for (const l of lines) {
    const s = roundSize(l.size)
    weights.set(s, (weights.get(s) ?? 0) + l.text.length)
  }
  let best = 10
  let bestWeight = -1
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size
      bestWeight = weight
    }
  }
  return best
}

function isHeadingCandidate(line: Line, body: number): boolean {
  if (line.size < body * 1.18) return false
  if (line.text.length > 160 || !/\p{L}/u.test(line.text)) return false
  if (line.text.length > 80 && /[.:;]$/.test(line.text)) return false
  return true
}

/** Maps distinct heading font sizes (largest first) to heading levels 1-4. */
function headingSizes(lines: Line[], body: number): Map<number, number> {
  const sizes = [
    ...new Set(lines.filter((l) => isHeadingCandidate(l, body)).map((l) => roundSize(l.size))),
  ].sort((a, b) => b - a)
  return new Map(sizes.map((s, i) => [s, Math.min(4, i + 1)]))
}

function typicalLineGap(pages: Line[][], body: number): number {
  const gaps: number[] = []
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const gap = (lines[i - 1] as Line).y - (lines[i] as Line).y
      if (gap > 0 && gap < body * 3) gaps.push(gap)
    }
  }
  if (gaps.length === 0) return body * 1.2
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] as number
}

function escapeBlockStart(text: string): string {
  return text.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3').replace(/^([#>+=])/, '\\$1')
}

function joinLine(paragraph: string, next: string): string {
  if (/\p{L}-$/u.test(paragraph) && /^\p{Ll}/u.test(next)) return paragraph.slice(0, -1) + next
  return `${paragraph} ${next}`
}

function linesToMarkdown(lines: Line[], body: number, levels: Map<number, number>, lineGap: number): string {
  const blocks: string[] = []
  let para: string | null = null
  let paraKind: 'p' | 'li' = 'p'
  let heading: { level: number; text: string; size: number } | null = null
  let prev: Line | null = null

  const flushPara = () => {
    if (para !== null) blocks.push(paraKind === 'li' ? para : escapeBlockStart(para))
    para = null
  }
  const flushHeading = () => {
    if (heading) blocks.push(`${'#'.repeat(heading.level)} ${heading.text}`)
    heading = null
  }

  for (const line of lines) {
    const level = isHeadingCandidate(line, body) ? levels.get(roundSize(line.size)) : undefined
    const gap = prev ? prev.y - line.y : 0
    if (level !== undefined) {
      flushPara()
      const current = heading as { level: number; text: string; size: number } | null
      if (current && current.level === level && gap >= 0 && gap < line.size * 1.8) {
        current.text = `${current.text} ${line.text}`
      } else {
        flushHeading()
        heading = { level, text: line.text, size: line.size }
      }
      prev = line
      continue
    }
    flushHeading()
    const isList = LIST_RE.test(line.text)
    const newParagraph =
      para === null ||
      isList ||
      gap < 0 ||
      gap > lineGap * 1.45 ||
      (prev !== null && line.x0 > prev.x0 + body * 1.5 && paraKind === 'p')
    if (newParagraph) {
      flushPara()
      if (isList) {
        para = BULLET_RE.test(line.text) ? line.text.replace(BULLET_RE, '- ') : line.text
        paraKind = 'li'
      } else {
        para = line.text
        paraKind = 'p'
      }
    } else {
      para = joinLine(para as unknown as string, line.text)
    }
    prev = line
  }
  flushPara()
  flushHeading()
  // Consecutive list items form one list; other blocks are separated by a blank line.
  let out = ''
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as string
    if (i > 0) {
      const prevBlock = blocks[i - 1] as string
      const bothList = LIST_RE.test(prevBlock) && LIST_RE.test(b)
      out += bothList ? '\n' : '\n\n'
    }
    out += b
  }
  return out
}

/** Builds a new PDF that contains only `pageNumbers` (1-based), in order. */
export async function subsetPdf(bytes: Uint8Array, pageNumbers: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const out = await PDFDocument.create()
  const copied = await out.copyPages(
    src,
    pageNumbers.map((p) => p - 1),
  )
  for (const page of copied) out.addPage(page)
  return out.save()
}

/** Groups pages so that each request stays under `maxBytes` and `maxPages`. */
export function planPageBatches(
  pageNumbers: number[],
  totalBytes: number,
  totalPages: number,
  maxBytes: number,
  maxPages: number,
): number[][] {
  const bytesPerPage = totalBytes / Math.max(1, totalPages)
  const perBatch = Math.max(1, Math.min(maxPages, Math.floor(maxBytes / Math.max(1, bytesPerPage))))
  const out: number[][] = []
  for (let i = 0; i < pageNumbers.length; i += perBatch) out.push(pageNumbers.slice(i, i + perBatch))
  return out
}
