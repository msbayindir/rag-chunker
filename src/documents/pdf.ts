import { PDFDocument } from 'pdf-lib'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import { RagChunkerError } from '../errors.js'
import type { LayoutLabel, LayoutRegion, PageLayoutProvider, PageLike } from '../local/layout.js'
import type { OcrResult, PageOcrProvider } from '../local/ocr.js'
import type { ModelTable, TableStructureProvider } from '../local/table.js'
import { importOptional } from '../util/optional.js'
import {
  altText,
  captionFor,
  type FigureData,
  type FigureRequest,
  type FigureSink,
  figureCandidates,
  nearbyText,
} from './figures.js'
import { type Box, type TextSpan, unionBoxes } from './layout.js'
import {
  type DetectedTable,
  detectTables,
  extractRulings,
  gridRegions,
  headerTexts,
  type Rect,
  type Rulings,
  type TableData,
  tableToMarkdown,
  withHeaderOf,
} from './tables.js'

export interface PdfTextPage {
  pageNumber: number
  markdown: string
  /** Where the page text came from. */
  source: 'text-layer' | 'ocr'
  /** True when the page has no usable text layer (scanned or broken fonts). */
  scanned: boolean
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

/** One run of text: a pdf.js text item, or a line read by OCR. Coordinates in PDF points (y up). */
export interface TextItem {
  str: string
  x: number
  y: number
  width: number
  size: number
  font: string
  dir: string
  /** Text that is not horizontal (margin stamps, vertical labels). */
  rotated: boolean
  /** OCR confidence (0-1); absent for text-layer items. */
  confidence?: number
  /** Word runs inside an OCR line (page points); table detection splits cells at the gaps between them. */
  parts?: Array<{ str: string; x: number; width: number; confidence?: number }>
}
type RawItem = TextItem

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
  /** Set on the pseudo-line that stands for a figure; `text` is then the image reference. */
  figure?: FigureData
  /** Set on the pseudo-line that stands for a display formula; `text` is then `$$…$$`. */
  formula?: string
  /** Exact area (PDF points) when known, e.g. a table's grid. */
  bbox?: Rect
  /** Never a heading (a table's title row emitted as text, captions, footnotes…). */
  plain?: boolean
  /** Layout-model class of the region the line sits in. */
  label?: LayoutLabel
  /** Reading-order rank of that region (lower first). */
  order?: number
  /** A heading per the layout model: level 1 for the document title, otherwise inferred. */
  forceHeading?: 1 | 'auto'
  /** Lines of one title region merge into one heading whatever their sizes. */
  headingGroup?: number
  /** Always its own block (margin stamps, rotated labels). */
  standalone?: boolean
  /** Inside a body-text region, below its first line: only a larger font still makes it a heading. */
  inBody?: boolean
  /** Lowest OCR confidence among the line's items (OCR pages only). */
  confidence?: number
}

export interface TextLayerOptions {
  /** Layout analysis per page (classes + reading order); without it, position heuristics decide. */
  layout?: PageLayoutProvider
  /** OCR for pages that need it (scanned, broken text layer); `needed` decides per page. */
  ocr?: {
    needed(page: { pageNumber: number; chars: number; garbled: boolean }): boolean
    recognize: PageOcrProvider
  }
  /** Table structure model, run on the table regions the layout model reports. */
  tables?: TableStructureProvider
  /** Saves the figures of each page; without it no figures are reported. */
  figures?: FigureOptions
  /** Reads the display-formula regions the layout model reports as LaTeX; without it they stay text. */
  formulas?: FormulaProvider
}

/** Reads the formula in a layout region of a page as LaTeX (null when nothing usable came out). */
export type FormulaProvider = (doc: PageLike, pageNumber: number, region: Rect) => Promise<string | null>

export interface FigureOptions {
  save: FigureSink
  /** Smallest figure kept, as a share of the page area (default 0.015). */
  minSize?: number
}

/** Table regions that no drawn grid explains get their structure from the model. */
async function modelTablesFor(
  lines: Line[],
  regions: LayoutRegion[] | null,
  rulings: Rulings,
  recognize: ((region: Rect) => Promise<ModelTable | null>) | undefined,
): Promise<ModelTable[] | undefined> {
  if (!recognize || !regions) return undefined
  const hints = regions.filter((r) => r.label === 'table').map((r) => r.bbox)
  if (hints.length === 0) return []
  const grids = gridRegions(lines, rulings)
  const covered = (h: Rect) =>
    grids.some((g) => {
      const ix = Math.max(0, Math.min(h.x1, g.x1) - Math.max(h.x0, g.x0))
      const iy = Math.max(0, Math.min(h.y1, g.y1) - Math.max(h.y0, g.y0))
      return (ix * iy) / Math.max(1, (h.x1 - h.x0) * (h.y1 - h.y0)) >= 0.5
    })
  const out: ModelTable[] = []
  for (const hint of hints) {
    if (covered(hint)) continue
    const t = await recognize(hint)
    if (t) out.push(t)
  }
  return out
}

/**
 * Detected line heights are quantised to the detector's input resolution (a page shrunk to 960 px
 * puts body text at 10–15 detector pixels, so two lines of the same paragraph differ by 10–20 %).
 * Heights this close to the page's body height are taken as body height, or the heading rules
 * (1.18 × body) fire on ordinary lines and shred paragraphs. Real headings are larger than this.
 */
const OCR_BODY_BAND = { low: 0.8, high: 1.28 }

/** OCR lines (image pixels, origin top-left) as text items in PDF points. */
export function ocrItems(result: OcrResult, page: { width: number; height: number }): TextItem[] {
  const sx = page.width / result.width
  const sy = page.height / result.height
  const long = result.lines
    .filter((l) => l.text.length >= 20)
    .map((l) => (l.y1 - l.y0) * sy)
    .sort((a, b) => a - b)
  const body = long.length >= 5 ? (long[long.length >> 1] as number) : 0
  return result.lines.map((l) => {
    const h = (l.y1 - l.y0) * sy
    const snapped = body > 0 && h >= body * OCR_BODY_BAND.low && h < body * OCR_BODY_BAND.high ? body : h
    const size = snapped / 1.05
    return {
      str: l.text,
      x: l.x0 * sx,
      y: page.height - l.y1 * sy + (h / 1.05) * 0.25,
      width: (l.x1 - l.x0) * sx,
      size,
      font: 'ocr',
      dir: 'ltr',
      rotated: false,
      confidence: l.confidence,
      // The line stays one item (columns and reading order come from whole lines); its words
      // travel along so a scanned table can be split into cells at the gaps between them.
      ...(l.words && l.words.length > 1
        ? {
            parts: l.words.map((w) => ({
              str: w.text,
              x: w.x0 * sx,
              width: (w.x1 - w.x0) * sx,
              confidence: w.confidence,
            })),
          }
        : {}),
    }
  })
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
  async textLayer(options: TextLayerOptions = {}): Promise<PdfTextPage[]> {
    const pages: Array<{
      pageNumber: number
      lines: Line[]
      width: number
      height: number
      chars: number
      garbled: boolean
      source: 'text-layer' | 'ocr'
      scanned: boolean
    }> = []
    for (let n = 1; n <= this.pageCount; n++) {
      const page = await this.proxy.getPage(n)
      const { width, height } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      let items: RawItem[] = []
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
      let chars = raw.replace(/\s+/g, '').length
      const garbled = isGarbled(raw)
      const scanned = chars === 0 || garbled
      let source: 'text-layer' | 'ocr' = 'text-layer'
      if (options.ocr?.needed({ pageNumber: n, chars, garbled })) {
        items = ocrItems(await options.ocr.recognize(this, n), { width, height })
        chars = items.reduce((n, it) => n + it.str.replace(/\s+/g, '').length, 0)
        source = 'ocr'
      }
      const regions = options.layout ? await options.layout(this, n) : null
      const rulings = await extractRulings(page).catch((): Rulings => ({ h: [], v: [] }))
      const lines0 = toLines(items, width, regions)
      const models = await modelTablesFor(
        lines0,
        regions,
        rulings,
        options.tables ? (region) => (options.tables as TableStructureProvider)(this, n, region) : undefined,
      )
      const figures = options.figures
        ? await figuresOnPage(
            lines0,
            regions,
            rulings.images ?? [],
            { width, height },
            options.figures.minSize,
            (f) => (options.figures as FigureOptions).save(this, n, f),
          )
        : []
      const formulas = options.formulas
        ? await formulasOnPage(regions, (r) => (options.formulas as FormulaProvider)(this, n, r))
        : undefined
      pages.push({
        pageNumber: n,
        lines: composePage(items, { width, height }, regions, rulings, models, figures, formulas),
        width,
        height,
        chars,
        garbled,
        source,
        scanned,
      })
    }
    const prose = pages.filter((p) => p.source === 'text-layer').map((p) => p.lines.filter((l) => !l.table))
    const typo = typography(prose)
    typo.levelMap = levelMap(prose, typo)
    const out = pages.map((p) => {
      // OCR line heights are not font sizes: an OCR page is measured against itself only.
      let pageTypo = typo
      if (p.source === 'ocr') {
        const own = [p.lines.filter((l) => !l.table)]
        pageTypo = typography(own)
        pageTypo.levelMap = levelMap(own, pageTypo)
      }
      const { markdown, spans } = linesToMarkdown(p.lines, pageTypo, p)
      return {
        pageNumber: p.pageNumber,
        markdown,
        source: p.source,
        scanned: p.scanned,
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

/**
 * Lines of one page in reading order: text runs grouped into lines, layout regions applied,
 * tables lifted out of the flow and put back as pseudo-lines, columns ordered.
 */
/** Display formulas read from the page image: their lines replace whatever text fell inside the region. */
export interface PageFormulas {
  lines: Line[]
  /** True for a text line that lies inside a recognised formula region. */
  inside: (line: Line) => boolean
}

function composePage(
  items: RawItem[],
  page: { width: number; height: number },
  regions: LayoutRegion[] | null,
  rulings: Rulings,
  models?: ModelTable[],
  figures: Line[] = [],
  formulas?: PageFormulas,
): Line[] {
  let lines = toLines(items, page.width, regions)
  if (regions) lines = applyLayout(lines, regions)
  if (formulas && formulas.lines.length > 0) lines = lines.filter((l) => !formulas.inside(l))
  const hints = regions?.filter((r) => r.label === 'table').map((r) => r.bbox)
  const { tables, remaining } = detectTables(lines, rulings, { width: page.width, hints, models })
  const tableFlow = tables.flatMap((t) => tableLines(t, regions))
  const withTables = [...remaining, ...tableFlow, ...figures, ...(formulas?.lines ?? [])].sort(
    (a, b) => b.y - a.y || a.x0 - b.x0,
  )
  return regions ? orderByLayout(withTables) : orderColumns(withTables, page.width)
}

/**
 * Runs the formula recogniser on every confident display-formula region of the page and turns
 * each result into a standalone `$$…$$` line that takes the region's place in the reading order.
 * Lines of OCR or text-layer glyphs inside those regions are dropped by `composePage`: they were
 * never text, and the recognised LaTeX replaces them.
 */
export async function formulasOnPage(
  regions: LayoutRegion[] | null,
  recognise: (region: Rect) => Promise<string | null>,
): Promise<PageFormulas | undefined> {
  if (!regions) return undefined
  const targets = regions.filter((r) => r.label === 'display_formula' && r.score >= CONFIDENT)
  if (targets.length === 0) return undefined
  const lines: Line[] = []
  const boxes: Rect[] = []
  for (const r of targets) {
    let latex: string | null = null
    try {
      latex = await recognise(r.bbox)
    } catch {
      latex = null
    }
    if (!latex) continue
    boxes.push(r.bbox)
    lines.push({
      text: `$$${latex}$$`,
      y: r.bbox.y1 - 3,
      x0: r.bbox.x0,
      x1: r.bbox.x1,
      size: 10,
      font: '',
      fontShare: 1,
      bbox: r.bbox,
      label: 'display_formula',
      standalone: true,
      plain: true,
      formula: latex,
      ...(r.order !== undefined ? { order: r.order } : {}),
    })
  }
  if (lines.length === 0) return undefined
  const inside = (l: Line) => {
    const cx = (l.x0 + l.x1) / 2
    const cy = l.y + l.size * 0.35
    return boxes.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1)
  }
  return { lines, inside }
}

/** A page built from text items alone (OCR of an image): same headings, lists and tables as a PDF page. */
export async function pageFromItems(
  items: TextItem[],
  page: { width: number; height: number },
  options: {
    regions?: LayoutRegion[] | null
    source?: PdfTextPage['source']
    tables?: (region: Rect) => Promise<ModelTable | null>
    figures?: {
      save: (figure: FigureRequest) => Promise<FigureData | null>
      minSize?: number
    }
    formulas?: (region: Rect) => Promise<string | null>
  } = {},
): Promise<PdfTextPage> {
  const none: Rulings = { h: [], v: [] }
  const lines0 = toLines(items, page.width, options.regions ?? null)
  const models = await modelTablesFor(lines0, options.regions ?? null, none, options.tables)
  const figures = options.figures
    ? await figuresOnPage(
        lines0,
        options.regions ?? null,
        [],
        page,
        options.figures.minSize,
        options.figures.save,
      )
    : []
  const formulas = options.formulas
    ? await formulasOnPage(options.regions ?? null, options.formulas)
    : undefined
  const lines = composePage(items, page, options.regions ?? null, none, models, figures, formulas)
  const prose = [lines.filter((l) => !l.table)]
  const typo = typography(prose)
  typo.levelMap = levelMap(prose, typo)
  const { markdown, spans } = linesToMarkdown(lines, typo, page)
  const chars = items.reduce((n, it) => n + it.str.replace(/\s+/g, '').length, 0)
  return {
    pageNumber: 1,
    markdown,
    source: options.source ?? 'ocr',
    scanned: true,
    width: page.width,
    height: page.height,
    spans,
    chars,
    garbled: false,
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

function toLines(all: RawItem[], pageWidth: number, regions: LayoutRegion[] | null = null): Line[] {
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
  // With layout regions, runs that fall into different regions never share a line: the columns
  // of a scanned page are kept apart even when their text sits on one baseline.
  const regionOf = (it: RawItem) =>
    regions && regions.length > 0 ? regionAt(it.x + it.width / 2, it.y + it.size * 0.35, regions) : null
  for (const l of lines) {
    const its = l.items.sort((a, b) => a.x - b.x)
    let current: RawItem[] = []
    let lastEnd = Number.NEGATIVE_INFINITY
    let lastRegion: LayoutRegion | null = null
    for (const it of its) {
      const gap = it.x - lastEnd
      const acrossGutter =
        gutter !== null &&
        lastEnd <= gutter + 1 &&
        it.x >= gutter - 1 &&
        gap > (pageGutter !== null ? 2 : Math.max(it.size * 0.9, 8))
      const region = regionOf(it)
      const otherRegion =
        current.length > 0 && region !== null && lastRegion !== null && region !== lastRegion && gap > 1
      if (current.length > 0 && (gap > Math.max(it.size * 1.8, 12) || acrossGutter || otherRegion)) {
        segments.push(current)
        current = []
      }
      current.push(it)
      lastEnd = it.x + it.width
      lastRegion = region
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
    const confidences = its.map((it) => it.confidence).filter((c): c is number => c !== undefined)
    out.push({
      text,
      y: first.y,
      x0: first.x,
      x1: lastEnd,
      size: sizeWeight > 0 ? sizeSum / sizeWeight : first.size,
      font,
      fontShare: sizeWeight > 0 ? Math.max(0, best) / sizeWeight : 1,
      ...(confidences.length > 0 ? { confidence: Math.min(...confidences) } : {}),
      // pdf.js reports a gap wider than 0.6 em as a whitespace item of that width. Prose keeps
      // those items (they bridge label/value pairs into one line); table detection uses the real
      // runs and measures the gaps itself.
      items: its
        .flatMap((it) =>
          it.parts?.length
            ? it.parts.map((p) => ({
                ...it,
                str: p.str,
                x: p.x,
                width: p.width,
                ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
                parts: undefined,
              }))
            : [it],
        )
        .filter((it) => it.str.trim() !== ''),
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
  if (line.forceHeading === 1) return 1
  if (isSizeHeading(line, typo.body)) return typo.sizeLevels.get(roundSize(line.size))
  if (line.inBody) return undefined
  if (isStyleHeading(line, prev, typo, gapAbove, following)) return styleLevel(line.text, typo)
  // The layout model saw a section title the typography did not reveal.
  if (line.forceHeading === 'auto') return styleLevel(line.text, typo)
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
  const blocks: Array<{ text: string; lines: Line[]; table?: TableData; figure?: FigureData }> = []
  const labelOf = (ls: Line[]) => ls.find((l) => l.label)?.label
  let para: string | null = null
  let paraLines: Line[] = []
  let paraKind: 'p' | 'li' = 'p'
  let heading: { level: number; text: string; size: number; lines: Line[]; group?: number } | null = null
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
    if (line.table || line.standalone || line.rotated) {
      flushPara()
      flushHeading()
      blocks.push({
        text: line.text,
        lines: [line],
        ...(line.table ? { table: line.table } : {}),
        ...(line.figure ? { figure: line.figure } : {}),
      })
      prev = line
      continue
    }
    const raw = repeated.has(line.text)
      ? undefined
      : rawHeadingLevel(line, prev, typo, gap, lines.slice(i + 1, i + 4))
    const level = raw === undefined ? undefined : (typo.levelMap.get(raw) ?? raw)
    if (level !== undefined) {
      flushPara()
      const current = heading as {
        level: number
        text: string
        size: number
        lines: Line[]
        group?: number
      } | null
      // Lines of one title region always merge; a title region never absorbs a neighbour.
      const grouped = current?.group !== undefined || line.headingGroup !== undefined
      const sameGroup = current?.group !== undefined && current.group === line.headingGroup
      const adjacent = !grouped && current?.level === level && gap >= 0 && gap < line.size * 1.8
      if (current && (sameGroup || adjacent)) {
        current.text = `${current.text} ${line.text}`
        current.lines.push(line)
      } else {
        flushHeading()
        heading = { level, text: line.text, size: line.size, lines: [line], group: line.headingGroup }
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
    if (!box) continue
    const label = labelOf(b.lines)
    const confidences = b.lines.map((l) => l.confidence).filter((c): c is number => c !== undefined)
    spans.push({
      text: b.text,
      box,
      ...(b.table ? { table: b.table } : {}),
      ...(b.figure ? { figure: b.figure } : {}),
      ...(label ? { label } : {}),
      ...(confidences.length > 0 ? { confidence: Math.round(Math.min(...confidences) * 1000) / 1000 } : {}),
    })
  }
  return { markdown: out, spans }
}

/** Text in these regions never reaches the markdown: page furniture and the labels inside figures. */
const DROP_LABELS = new Set<LayoutLabel>([
  'header',
  'footer',
  'number',
  'header_image',
  'footer_image',
  'seal',
  'image',
  'chart',
])
/** Text in these regions is never a heading (body text is handled by `inBody`). */
const PLAIN_LABELS = new Set<LayoutLabel>([
  'figure_title',
  'footnote',
  'vision_footnote',
  'reference',
  'reference_content',
  'aside_text',
  'abstract',
  'algorithm',
  'display_formula',
  'inline_formula',
  'formula_number',
  'content',
  'vertical_text',
])
/** Regions read after everything else on the page (margin stamps, vertical labels). */
const LAST_LABELS = new Set<LayoutLabel>(['aside_text', 'vertical_text'])
const CONFIDENT = 0.6

function regionAt(cx: number, cy: number, regions: LayoutRegion[]): LayoutRegion | null {
  let best: LayoutRegion | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const r of regions) {
    const { x0, x1, y0, y1 } = r.bbox
    if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue
    const a = (x1 - x0) * (y1 - y0)
    if (a < bestArea) {
      best = r
      bestArea = a
    }
  }
  if (best) return best
  // Not inside any region: the nearest one (gaps between regions are narrow).
  let bestDist = Number.POSITIVE_INFINITY
  for (const r of regions) {
    const { x0, x1, y0, y1 } = r.bbox
    const dx = Math.max(x0 - cx, 0, cx - x1)
    const dy = Math.max(y0 - cy, 0, cy - y1)
    const d = Math.hypot(dx, dy)
    if (d < bestDist) {
      best = r
      bestDist = d
    }
  }
  return best
}

/**
 * Tags lines with the layout model's verdict: drops page furniture and figure labels, marks blocks
 * that are never headings, promotes titles, and records the region's reading-order rank.
 */
function applyLayout(lines: Line[], regions: LayoutRegion[]): Line[] {
  if (regions.length === 0) return lines
  const out: Line[] = []
  // The first (topmost) line of a body-text region may still be a title the model merged into it.
  const leading = new Map<LayoutRegion, Line>()
  const regionOf = new Map<Line, LayoutRegion | null>()
  for (const line of lines) {
    const r = regionAt((line.x0 + line.x1) / 2, line.y + line.size * 0.35, regions)
    regionOf.set(line, r)
    if (r && (!leading.has(r) || line.y > (leading.get(r) as Line).y)) leading.set(r, line)
  }
  for (const line of lines) {
    const r = regionOf.get(line) ?? null
    if (!r) {
      out.push(line)
      continue
    }
    // Figure labels are short fragments; a confident region drops everything inside it.
    if (DROP_LABELS.has(r.label) && (r.score >= CONFIDENT || line.text.length < 30)) continue
    line.label = r.label
    line.order = LAST_LABELS.has(r.label) ? Number.POSITIVE_INFINITY : r.order
    if (LAST_LABELS.has(r.label)) line.standalone = true
    // Captions, footnotes, references… never become headings, however bold they are; inside a
    // body-text block only its first line keeps that chance.
    if (PLAIN_LABELS.has(r.label)) line.plain = true
    if (r.label === 'text' && r.score >= CONFIDENT && leading.get(r) !== line) line.inBody = true
    if (r.score >= CONFIDENT && r.label === 'doc_title') {
      line.forceHeading = 1
      line.headingGroup = regions.indexOf(r)
    } else if (
      r.score >= 0.7 &&
      r.label === 'paragraph_title' &&
      line.text.length <= 200 &&
      !/[=[\]{}|]/.test(line.text)
    ) {
      line.forceHeading = 'auto'
      line.headingGroup = regions.indexOf(r)
    }
    out.push(line)
  }
  return out
}

/** Reading order from the layout model: region rank, then top to bottom and left to right inside it. */
function orderByLayout(lines: Line[]): Line[] {
  return [...lines].sort((a, b) => {
    const oa = a.order ?? Number.POSITIVE_INFINITY
    const ob = b.order ?? Number.POSITIVE_INFINITY
    if (oa !== ob) return oa - ob
    return b.y - a.y || a.x0 - b.x0
  })
}

/**
 * The figures of a page as pseudo-lines: the image reference (alt text = caption) and, when a
 * vision model described it, the description as a paragraph right below.
 */
async function figuresOnPage(
  lines: Line[],
  regions: LayoutRegion[] | null,
  images: Rect[],
  page: { width: number; height: number },
  minSize: number | undefined,
  save: (figure: FigureRequest) => Promise<FigureData | null>,
): Promise<Line[]> {
  const prose = lines.filter((l) => !l.table && !l.rotated)
  const candidates = figureCandidates({ lines: prose, regions, images, page, minSize: minSize ?? 0.015 })
  const out: Line[] = []
  for (const c of candidates) {
    const caption = captionFor(c.bbox, prose, regions)
    const nearby = caption ? undefined : nearbyText(c.bbox, prose)
    const data = await save({
      bbox: c.bbox,
      label: c.label,
      ...(caption ? { caption: caption.text } : {}),
      ...(nearby ? { nearby } : {}),
    })
    if (!data) continue
    const region =
      c.order === undefined && regions
        ? regionAt((c.bbox.x0 + c.bbox.x1) / 2, (c.bbox.y0 + c.bbox.y1) / 2, regions)
        : null
    const order = c.order ?? region?.order
    const base = {
      size: 6,
      font: '',
      fontShare: 1,
      x0: c.bbox.x0,
      x1: c.bbox.x1,
      bbox: c.bbox,
      label: c.label,
      standalone: true as const,
      ...(order !== undefined ? { order } : {}),
    }
    out.push({
      ...base,
      text: `![${altText(data.caption, c.label)}](${data.file})`,
      y: c.bbox.y1 - 3,
      figure: data,
    })
    if (data.description) out.push({ ...base, text: data.description, y: c.bbox.y1 - 4, plain: true })
  }
  return out
}

/** The pseudo-lines that stand for a table in the text flow: its title row, if any, then the table. */
function tableLines(t: DetectedTable, regions: LayoutRegion[] | null): Line[] {
  const region = regions ? regionAt((t.bbox.x0 + t.bbox.x1) / 2, (t.bbox.y0 + t.bbox.y1) / 2, regions) : null
  const base = {
    size: 6,
    font: '',
    fontShare: 1,
    ...(region ? { order: region.order, label: 'table' as const } : {}),
  }
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
