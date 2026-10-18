import { PDFDocument } from 'pdf-lib'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import { RagChunkerError } from '../errors.js'
import { importOptional } from '../util/optional.js'
import { type Box, type TextSpan, unionBoxes } from './layout.js'
import {
  type DetectedTable,
  detectTables,
  extractRulings,
  headerTexts,
  type Rect,
  type TableData,
  tableToMarkdown,
  withHeaderOf,
} from './tables.js'

export interface PdfTextPage {
  pageNumber: number
  markdown: string
  /** Page size in PDF points. */
  width: number
  height: number
  /** One entry per heading, paragraph or list item of `markdown`, with its position on the page. */
  spans: TextSpan[]
  /** Non-whitespace characters on the page. */
  chars: number
  /** True when the text layer looks broken (missing ToUnicode maps, private-use glyphs…). */
  garbled: boolean
}

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>

interface RawItem {
  str: string
  x: number
  y: number
  width: number
  size: number
  font: string
  dir: string
  /** Text that is not horizontal (margin stamps, vertical labels). */
  rotated: boolean
}

interface Line {
  text: string
  y: number
  x0: number
  x1: number
  size: number
  /** pdf.js font id that covers most characters of the line. */
  font: string
  /** Share of the line's characters written in `font`. */
  fontShare: number
  rotated?: boolean
  /** Glyph runs the line was built from. */
  items?: RawItem[]
  /** Set on the pseudo-line that stands for a table; `text` is then the markdown table. */
  table?: TableData
  /** Exact area (PDF points) when known, e.g. a table's grid. */
  bbox?: Rect
  /** Never a heading (a table's title row emitted as text). */
  plain?: boolean
}

/** Document-wide typography used to recognise headings. */
interface Typography {
  body: number
  bodyFont: string
  fontShare: Map<string, number>
  sizeLevels: Map<number, number>
  lineGap: number
  hasCapsHeadings: boolean
  /** Raw heading level → compact level (no gaps such as 1, 2, 3, 6). */
  levelMap: Map<number, number>
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
      proxy = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
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
    const pages: Array<{
      pageNumber: number
      lines: Line[]
      width: number
      height: number
      chars: number
      garbled: boolean
    }> = []
    for (let n = 1; n <= this.pageCount; n++) {
      const page = await this.proxy.getPage(n)
      const { width, height } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items: RawItem[] = []
      for (const it of content.items as Array<Record<string, unknown>>) {
        if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue
        const t = it.transform as number[]
        const scale = Math.hypot(t[0] ?? 0, t[1] ?? 0) || 1
        items.push({
          str: it.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          width: typeof it.width === 'number' ? it.width : 0,
          size: Math.hypot(t[0] ?? 0, t[1] ?? 0) || Math.hypot(t[2] ?? 0, t[3] ?? 0),
          font: typeof it.fontName === 'string' ? it.fontName : '',
          dir: typeof it.dir === 'string' ? it.dir : 'ltr',
          rotated: Math.abs(t[1] ?? 0) > scale * 0.05 || Math.abs(t[2] ?? 0) > scale * 0.05,
        })
      }
      const raw = items.map((it) => it.str).join('')
      const lines = toLines(items, width)
      // Tables leave the text flow; a pseudo-line at the table's top keeps its place in reading order.
      const rulings = await extractRulings(page).catch(() => ({ h: [], v: [] }))
      const { tables, remaining } = detectTables(lines, rulings, { width })
      const withTables = [...remaining, ...tables.flatMap(tableLines)].sort(
        (a, b) => b.y - a.y || a.x0 - b.x0,
      )
      pages.push({
        pageNumber: n,
        lines: orderColumns(withTables, width),
        width,
        height,
        chars: raw.replace(/\s+/g, '').length,
        garbled: isGarbled(raw),
      })
    }
    const prose = pages.map((p) => p.lines.filter((l) => !l.table))
    const typo = typography(prose)
    typo.levelMap = levelMap(prose, typo)
    const out = pages.map((p) => {
      const { markdown, spans } = linesToMarkdown(p.lines, typo, p)
      return {
        pageNumber: p.pageNumber,
        markdown,
        width: p.width,
        height: p.height,
        spans,
        chars: p.chars,
        garbled: p.garbled,
      }
    })
    carryTableHeaders(out)
    return out
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

/**
 * The x position of a column gutter: a vertical strip no text item crosses, with many items ending
 * just left of it and many starting just right of it. Narrow gutters (~16pt in ACL papers) are
 * smaller than the gap that otherwise separates segments of a line.
 */
function columnGutter(items: RawItem[], width: number): number | null {
  const text = items.filter((it) => it.width > 0 && it.str.trim() !== '')
  if (text.length < 10 || width <= 0) return null
  const ends = text.map((it) => it.x + it.width)
  let best: { x: number; score: number } | null = null
  for (let x = Math.floor(width * 0.3); x <= width * 0.7; x++) {
    let crossing = 0
    let left = 0
    let right = 0
    for (let i = 0; i < text.length; i++) {
      const it = text[i] as RawItem
      const end = ends[i] as number
      if (it.x < x - 1 && end > x + 1) crossing++
      else if (end <= x + 1 && end > x - 40) left++
      else if (it.x >= x - 1 && it.x < x + 40) right++
    }
    const score = Math.min(left, right)
    if (score >= 5 && crossing <= score * 0.5 && (!best || score > best.score)) best = { x, score }
  }
  const baselines = new Set(text.map((it) => Math.round(it.y))).size
  return best && best.score >= baselines * 0.2 ? best.x : null
}

/**
 * The gutter of side-by-side blocks on a single-column page (comparison tables, boxed examples):
 * at least three lines hold two wide runs of text an em or more apart, at the same x.
 */
function blockGutter(lines: Array<{ items: RawItem[] }>, width: number): number | null {
  const gaps: Array<[number, number]> = []
  for (const l of lines) {
    const its = l.items.filter((it) => it.str.trim() !== '').sort((a, b) => a.x - b.x)
    const first = its[0]
    if (!first) continue
    const lineEnd = its.reduce((m, it) => Math.max(m, it.x + it.width), 0)
    let lastEnd = first.x + first.width
    for (const it of its.slice(1)) {
      const gap = it.x - lastEnd
      if (
        gap > Math.max(it.size * 0.9, 8) &&
        lastEnd - first.x >= width * 0.25 &&
        lineEnd - it.x >= width * 0.2
      ) {
        gaps.push([lastEnd, it.x])
        break
      }
      lastEnd = Math.max(lastEnd, it.x + it.width)
    }
  }
  if (gaps.length < 3) return null
  let best = 0
  let from = 0
  let to = 0
  for (let x = Math.floor(width * 0.25); x <= width * 0.75; x++) {
    const n = gaps.filter(([a, b]) => a <= x && x <= b).length
    if (n > best) {
      best = n
      from = x
      to = x
    } else if (n === best && to === x - 1) {
      to = x
    }
  }
  return best >= 3 ? (from + to) / 2 : null
}

function toLines(all: RawItem[], pageWidth: number): Line[] {
  const rotated: Line[] = all
    .filter((it) => it.rotated && it.str.trim() !== '')
    .map((it) => ({
      text: it.str.replace(/\s+/g, ' ').trim(),
      y: it.y,
      x0: it.x,
      x1: it.x + it.width,
      size: it.size,
      font: it.font,
      fontShare: 1,
      rotated: true,
    }))
  const items = all.filter((it) => !it.rotated)
  const sorted = items
    .filter((it) => it.str.length > 0 && it.dir !== 'ttb')
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Array<{ items: RawItem[]; y: number }> = []
  for (const it of sorted) {
    const tolerance = Math.max(2, it.size * 0.45)
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tolerance)
    if (line) line.items.push(it)
    else lines.push({ items: [it], y: it.y })
  }
  // Items on the same baseline but separated by a wide gap, or by a column gutter, belong to
  // different columns.
  const pageGutter = columnGutter(sorted, pageWidth)
  const gutter = pageGutter ?? blockGutter(lines, pageWidth)
  const segments: RawItem[][] = []
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x)
    let current: RawItem[] = []
    let lastEnd = Number.NEGATIVE_INFINITY
    for (const it of its) {
      const gap = it.x - lastEnd
      const acrossGutter =
        gutter !== null &&
        lastEnd <= gutter + 1 &&
        it.x >= gutter - 1 &&
        gap > (pageGutter !== null ? 2 : Math.max(it.size * 0.9, 8))
      if (current.length > 0 && (gap > Math.max(it.size * 1.8, 12) || acrossGutter)) {
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
    const fontChars = new Map<string, number>()
    for (const it of its) {
      const gap = it.x - lastEnd
      if (text !== '' && gap > it.size * 0.2 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' '
      text += it.str
      lastEnd = it.x + it.width
      const w = it.str.replace(/\s+/g, '').length
      sizeWeight += w
      sizeSum += it.size * w
      if (w > 0) fontChars.set(it.font, (fontChars.get(it.font) ?? 0) + w)
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const first = its[0] as RawItem
    let font = first.font
    let best = -1
    for (const [f, n] of fontChars) {
      if (n > best) {
        font = f
        best = n
      }
    }
    out.push({
      text,
      y: first.y,
      x0: first.x,
      x1: lastEnd,
      size: sizeWeight > 0 ? sizeSum / sizeWeight : first.size,
      font,
      fontShare: sizeWeight > 0 ? Math.max(0, best) / sizeWeight : 1,
      // pdf.js reports a gap wider than 0.6 em as a whitespace item of that width. Prose keeps
      // those items (they bridge label/value pairs into one line); table detection uses the real
      // runs and measures the gaps itself.
      items: its.filter((it) => it.str.trim() !== ''),
    })
  }
  return [...out.sort((a, b) => b.y - a.y || a.x0 - b.x0), ...rotated]
}

type Side = 'L' | 'R' | 'F'

/**
 * Reads two-column text column by column instead of line by line across both columns. Lines that
 * cross the gutter (titles, full-width captions and footnotes) stay in place and split the page
 * into regions, so text above or below the columns is not pulled into the left column.
 */
function orderColumns(allLines: Line[], width: number): Line[] {
  const extra = allLines.filter((l) => l.rotated)
  const lines = allLines.filter((l) => !l.rotated)
  if (lines.length < 6 || width <= 0) return allLines
  const rows = rowsOf(lines)
  const page = pageColumns(lines, width)
  if (page) return [...readAroundGutter(rows, page, false), ...extra]
  const block = sideBySideBlocks(rows, width)
  return [...(block ? readAroundGutter(rows, block, true) : lines), ...extra]
}

function rowsOf(lines: Line[]): Line[][] {
  const rows: Line[][] = []
  for (const line of lines) {
    const row = rows.at(-1)
    const head = row?.[0]
    if (row && head && Math.abs(head.y - line.y) <= Math.max(2, line.size * 0.45)) row.push(line)
    else rows.push([line])
  }
  return rows
}

/** A two-column page: many lines start right of the middle and many end left of it. */
function pageColumns(lines: Line[], width: number): ((l: Line) => Side) | null {
  if (lines.length < 8) return null
  const mid = width / 2
  const side = (l: Line): Side => (l.x0 >= mid * 0.95 ? 'R' : l.x1 <= mid * 1.1 ? 'L' : 'F')
  const right = lines.filter((l) => side(l) === 'R').length
  const left = lines.filter((l) => side(l) === 'L').length
  return right >= lines.length * 0.25 && left >= lines.length * 0.25 ? side : null
}

/**
 * Side-by-side blocks on a single-column page (comparison tables, boxed examples): rows made of
 * two wide text segments reveal the gutter.
 */
function sideBySideBlocks(rows: Line[][], width: number): ((l: Line) => Side) | null {
  const wide = (l: Line | undefined) => !!l && l.x1 - l.x0 >= width * 0.2
  const gaps: Array<[number, number]> = []
  for (const row of rows) {
    const [a, b] = row
    if (row.length === 2 && a && b && wide(a) && wide(b)) gaps.push([a.x1, b.x0])
  }
  if (gaps.length < 3) return null
  let best = 0
  let from = 0
  let to = 0
  for (let x = Math.floor(width * 0.25); x <= width * 0.75; x++) {
    const n = gaps.filter(([a, b]) => a <= x && x <= b).length
    if (n > best) {
      best = n
      from = x
      to = x
    } else if (n === best && to === x - 1) {
      to = x
    }
  }
  if (best < 3) return null
  const gutter = (from + to) / 2
  return (l) => (l.x1 <= gutter + 1 ? 'L' : l.x0 >= gutter - 1 ? 'R' : 'F')
}

/**
 * Emits each run of rows that stays clear of the gutter left side first, then right side. In
 * `blocks` mode (side-by-side blocks inside single-column text) runs also end at rows with more
 * than two segments and at paragraph gaps, and are only reordered when a row has both sides.
 */
function readAroundGutter(rows: Line[][], side: (l: Line) => Side, blocks: boolean): Line[] {
  const steps = rows
    .slice(1)
    .map((r, i) => ((rows[i] as Line[])[0] as Line).y - (r[0] as Line).y)
    .filter((d) => d > 0)
    .sort((a, b) => a - b)
  const lineGap = steps[Math.floor(steps.length / 2)] ?? 12
  const out: Line[] = []
  let run: Line[][] = []
  const flush = () => {
    const flat = run.flat()
    const reorder = blocks
      ? run.some((r) => r.some((l) => side(l) === 'L') && r.some((l) => side(l) === 'R'))
      : flat.some((l) => side(l) === 'R')
    if (reorder) out.push(...flat.filter((l) => side(l) === 'L'), ...flat.filter((l) => side(l) === 'R'))
    else out.push(...flat)
    run = []
  }
  for (const row of rows) {
    if (row.some((l) => side(l) === 'F') || (blocks && row.length > 2)) {
      flush()
      out.push(...row)
      continue
    }
    const last = run.at(-1)?.[0]
    if (blocks && last && last.y - (row[0] as Line).y > lineGap * 1.6) flush()
    run.push(row)
  }
  flush()
  return out
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

const TOC_RE = /(\.\s?){4,}|…{2,}|\s\.{2,}\s*\d+$/u
const TITLE_PREFIX_RE = /^(prof|doç|doc|dr|uz|op|yrd|arş|öğr|assoc|asst)\.\s/iu

/** Table-of-contents entries and numeric rows are never headings. */
function looksLikeNonHeading(text: string): boolean {
  if (TOC_RE.test(text)) return true
  if (NUMBERED_RE.test(text) && /\s\d{1,4}$/.test(text)) return true
  if (TITLE_PREFIX_RE.test(text)) return true
  const numbers = text.replace(NUMBERED_RE, (m) => m.slice(-1)).match(/\d+(?:[.,]\d+)?%?/g) ?? []
  return numbers.length >= 3 || (numbers.length >= 2 && numbers.some((n) => n.endsWith('%')))
}

function isSizeHeading(line: Line, body: number): boolean {
  if (line.rotated || line.size < body * 1.18) return false
  if (looksLikeNonHeading(line.text)) return false
  if (line.text.length > 160 || !/\p{L}/u.test(line.text)) return false
  if (line.text.length > 80 && /[.:;]$/.test(line.text)) return false
  return true
}

const CAPTION_RE = /^(tablo|şekil|resim|grafik|table|figure|fig\.|chart)\s*\d/iu
const NUMBERED_RE = /^(\d{1,2}(?:\.\d{1,2}){0,5})\.?\s+\S/u

function isCaps(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 4) return false
  const upper = letters.filter(
    (c) => c === c.toLocaleUpperCase('tr') && c !== c.toLocaleLowerCase('tr'),
  ).length
  return upper / letters.length >= 0.9
}

const endsBlock = (text: string) => /[.:;!?)\]"”’]$/.test(text)

/**
 * Body-size headings written in a different, rarely used font (bold or another face): section titles
 * in papers, legal texts and guidelines are usually set this way rather than larger.
 */
/**
 * A line followed by more lines in the same font at normal line spacing starts a paragraph set in
 * that font (boxed examples, quotes), not a heading: four or more lines, or three ending a sentence.
 * Headings rarely wrap past three lines; all-caps blocks are left to the other rules.
 */
function continuesAsParagraph(line: Line, following: Line[], typo: Typography): boolean {
  if (isCaps(line.text)) return false
  let above = line
  let count = 0
  for (const next of following.slice(0, 3)) {
    const step = above.y - next.y
    if (next.font !== line.font || Math.abs(next.size - line.size) > 0.5) break
    if (step <= 0 || step > typo.lineGap * 1.3) break
    count++
    above = next
  }
  return count >= 3 || (count === 2 && /[.!?]$/.test(above.text))
}

function isStyleHeading(
  line: Line,
  prev: Line | null,
  typo: Typography,
  gapAbove: number,
  following: Line[] = [],
): boolean {
  const t = line.text
  if (line.rotated || line.size < typo.body * 0.95 || line.size >= typo.body * 1.18) return false
  if (looksLikeNonHeading(t)) return false
  if (line.font === typo.bodyFont || line.fontShare < 0.9) return false
  if ((typo.fontShare.get(line.font) ?? 0) > 0.2) return false
  if (t.length < 2 || t.length > 120 || !/\p{L}/u.test(t)) return false
  if (!/^[\p{Lu}\d]/u.test(t) || CAPTION_RE.test(t) || BULLET_RE.test(t)) return false
  if (/[,;]$/.test(t)) return false
  const words = t.split(/\s+/).length
  if (words > 14) return false
  if (/[.!?]$/.test(t) && words > 6 && !NUMBERED_RE.test(t)) return false
  if (continuesAsParagraph(line, following, typo)) return false
  return prev === null || endsBlock(prev.text) || gapAbove > typo.lineGap * 1.3
}

function styleLevel(text: string, typo: Typography): number {
  const base = typo.sizeLevels.size
  const numbered = NUMBERED_RE.exec(text)
  if (numbered) return Math.min(6, base + (numbered[1] as string).split('.').length)
  if (isCaps(text)) return Math.min(6, base + 1)
  return Math.min(6, base + (typo.hasCapsHeadings ? 2 : 1))
}

function typography(pages: Line[][]): Typography {
  const all = pages.flat()
  const body = bodyFontSize(all)
  const fontChars = new Map<string, number>()
  let total = 0
  for (const l of all) {
    const n = l.text.length
    total += n
    fontChars.set(l.font, (fontChars.get(l.font) ?? 0) + n)
  }
  let bodyFont = ''
  let best = -1
  for (const [f, n] of fontChars) {
    if (n > best) {
      bodyFont = f
      best = n
    }
  }
  const fontShare = new Map([...fontChars].map(([f, n]) => [f, n / Math.max(1, total)]))
  const sizes = [...new Set(all.filter((l) => isSizeHeading(l, body)).map((l) => roundSize(l.size)))].sort(
    (a, b) => b - a,
  )
  const sizeLevels = new Map(sizes.map((s, i) => [s, Math.min(3, i + 1)]))
  const lineGap = typicalLineGap(pages, body)
  const typo: Typography = {
    body,
    bodyFont,
    fontShare,
    sizeLevels,
    lineGap,
    hasCapsHeadings: false,
    levelMap: new Map(),
  }
  // Only caps lines that would be style headings decide how unnumbered headings nest.
  typo.hasCapsHeadings = pages.some((lines) =>
    lines.some((l, i) => {
      const prev = lines[i - 1] ?? null
      const gap = prev ? prev.y - l.y : 0
      return isCaps(l.text) && isStyleHeading(l, prev, typo, gap, lines.slice(i + 1, i + 4))
    }),
  )
  return typo
}

function rawHeadingLevel(
  line: Line,
  prev: Line | null,
  typo: Typography,
  gapAbove: number,
  following: Line[],
): number | undefined {
  if (line.table || line.plain) return undefined
  if (isSizeHeading(line, typo.body)) return typo.sizeLevels.get(roundSize(line.size))
  if (isStyleHeading(line, prev, typo, gapAbove, following)) return styleLevel(line.text, typo)
  return undefined
}

/** Lines whose text occurs more than once on the page (figure labels, legend entries). */
function repeatedOnPage(lines: Line[]): Set<string> {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l.text, (counts.get(l.text) ?? 0) + 1)
  return new Set([...counts].filter(([, n]) => n > 1).map(([t]) => t))
}

/** Maps the raw levels used in the document onto 1..k without gaps. */
function levelMap(pages: Line[][], typo: Typography): Map<number, number> {
  const used = new Set<number>()
  for (const lines of pages) {
    const repeated = repeatedOnPage(lines)
    lines.forEach((l, i) => {
      if (repeated.has(l.text)) return
      const prev = lines[i - 1] ?? null
      const level = rawHeadingLevel(l, prev, typo, prev ? prev.y - l.y : 0, lines.slice(i + 1, i + 4))
      if (level !== undefined) used.add(level)
    })
  }
  return new Map([...used].sort((a, b) => a - b).map((lvl, i) => [lvl, Math.min(6, i + 1)]))
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

/** The area a line of text covers, as fractions of the page (ascent above and descent below the baseline). */
function lineBox(line: Line, page: { width: number; height: number }): Box {
  const top = line.bbox ? line.bbox.y1 : line.y + line.size * 0.8
  const bottom = line.bbox ? line.bbox.y0 : line.y - line.size * 0.25
  if (line.bbox) {
    return {
      x: line.bbox.x0 / page.width,
      y: (page.height - top) / page.height,
      w: (line.bbox.x1 - line.bbox.x0) / page.width,
      h: (top - bottom) / page.height,
    }
  }
  return {
    x: line.x0 / page.width,
    y: (page.height - top) / page.height,
    w: (line.x1 - line.x0) / page.width,
    h: (top - bottom) / page.height,
  }
}

function linesToMarkdown(
  lines: Line[],
  typo: Typography,
  page: { width: number; height: number },
): { markdown: string; spans: TextSpan[] } {
  const { body, lineGap } = typo
  const blocks: Array<{ text: string; lines: Line[]; table?: TableData }> = []
  let para: string | null = null
  let paraLines: Line[] = []
  let paraKind: 'p' | 'li' = 'p'
  let heading: { level: number; text: string; size: number; lines: Line[] } | null = null
  let prev: Line | null = null

  const flushPara = () => {
    if (para !== null)
      blocks.push({ text: paraKind === 'li' ? para : escapeBlockStart(para), lines: paraLines })
    para = null
    paraLines = []
  }
  const flushHeading = () => {
    if (heading) blocks.push({ text: `${'#'.repeat(heading.level)} ${heading.text}`, lines: heading.lines })
    heading = null
  }

  const repeated = repeatedOnPage(lines)
  for (const [i, line] of lines.entries()) {
    const gap = prev ? prev.y - line.y : 0
    if (line.table) {
      flushPara()
      flushHeading()
      blocks.push({ text: line.text, lines: [line], table: line.table })
      prev = line
      continue
    }
    const raw = repeated.has(line.text)
      ? undefined
      : rawHeadingLevel(line, prev, typo, gap, lines.slice(i + 1, i + 4))
    const level = raw === undefined ? undefined : (typo.levelMap.get(raw) ?? raw)
    if (level !== undefined) {
      flushPara()
      const current = heading as { level: number; text: string; size: number; lines: Line[] } | null
      if (current && current.level === level && gap >= 0 && gap < line.size * 1.8) {
        current.text = `${current.text} ${line.text}`
        current.lines.push(line)
      } else {
        flushHeading()
        heading = { level, text: line.text, size: line.size, lines: [line] }
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
    paraLines.push(line)
    prev = line
  }
  flushPara()
  flushHeading()
  // Consecutive list items form one list; other blocks are separated by a blank line.
  let out = ''
  for (let i = 0; i < blocks.length; i++) {
    const b = (blocks[i] as { text: string }).text
    if (i > 0) {
      const prevBlock = (blocks[i - 1] as { text: string }).text
      const bothList = LIST_RE.test(prevBlock) && LIST_RE.test(b)
      out += bothList ? '\n' : '\n\n'
    }
    out += b
  }
  const spans: TextSpan[] = []
  for (const b of blocks) {
    const box = unionBoxes(b.lines.map((l) => lineBox(l, page)))
    if (box) spans.push(b.table ? { text: b.text, box, table: b.table } : { text: b.text, box })
  }
  return { markdown: out, spans }
}

/** The pseudo-lines that stand for a table in the text flow: its title row, if any, then the table. */
function tableLines(t: DetectedTable): Line[] {
  const base = { size: 6, font: '', fontShare: 1 }
  const lines: Line[] = []
  if (t.caption) {
    const c = t.caption
    lines.push({
      ...base,
      text: c.text,
      y: c.bbox.y1 - 3,
      x0: c.bbox.x0,
      x1: c.bbox.x1,
      bbox: c.bbox,
      plain: true,
    })
  }
  lines.push({
    ...base,
    text: tableToMarkdown(t.data),
    y: t.bbox.y1 - 3,
    x0: t.bbox.x0,
    x1: t.bbox.x1,
    table: t.data,
    bbox: t.bbox,
  })
  return lines
}

/**
 * A table that ends at the bottom of a page and continues at the top of the next with the same
 * number of columns gets the first table's header, so every part reads on its own; a header the
 * document repeats itself is recognised and kept.
 */
function carryTableHeaders(pages: PdfTextPage[]): void {
  for (let i = 1; i < pages.length; i++) {
    const prevPage = pages[i - 1] as PdfTextPage
    const page = pages[i] as PdfTextPage
    const prev = prevPage.spans.at(-1)
    const cur = page.spans[0]
    if (!prev?.table || !cur?.table || prev.table.cols !== cur.table.cols) continue
    if (prev.box.y + prev.box.h < 0.8 || cur.box.y > 0.2) continue
    const same = headerTexts(prev.table).join('|') === headerTexts(cur.table).join('|')
    const data: TableData = same
      ? { ...cur.table, headerRows: prev.table.headerRows, continuation: true }
      : withHeaderOf(prev.table, cur.table)
    const markdown = tableToMarkdown(data)
    page.markdown = page.markdown.replace(cur.text, () => markdown)
    cur.text = markdown
    cur.table = data
  }
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
