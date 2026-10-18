import JSZip from 'jszip'
import { RagChunkerError } from '../errors.js'
import {
  attrsOf,
  childrenOf,
  find,
  relTargets,
  resolvePath,
  tagOf,
  textOf,
  walk,
  type XNode,
  xmlParser,
} from './ooxml.js'

/**
 * A thin .xlsx reader: every visible sheet becomes a page with the sheet name as heading and its
 * blocks of cells as GFM tables (blank rows separate tables, a lone cell above a table is its
 * title). Shared and inline strings, booleans, errors, percentages and dates (by number format)
 * are resolved; formulas contribute their cached result; merged cells repeat their value.
 */

export interface XlsxResult {
  markdown: string
  sheetCount: number
  warnings: string[]
}

type Cell = { text: string }

/** Column letters of an A1 reference → 0-based index. */
export function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
])
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 22, 45, 46, 47])
const BUILTIN_PERCENT_FORMATS = new Set([9, 10])

/** The format code without quoted text, bracketed sections and escaped characters. */
function bareFormat(code: string): string {
  return code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/AM\/PM|A\/P/gi, '')
}

export function isDateFormat(code: string): boolean {
  const bare = bareFormat(code)
  return /[dmyhs]/i.test(bare) && !/[#?]/.test(bare)
}

export function isTimeFormat(code: string): boolean {
  return /[hs]/i.test(bareFormat(code))
}

interface Styles {
  /** For each cellXfs index: 'date' | 'datetime' | 'percent' | undefined. */
  kind: Array<'date' | 'datetime' | 'percent' | undefined>
}

function parseStyles(xml: string | undefined): Styles {
  if (!xml) return { kind: [] }
  const doc = xmlParser.parse(xml) as XNode[]
  const custom = new Map<number, string>()
  const numFmts = find(doc, 'numFmts')
  for (const f of numFmts ? childrenOf(numFmts) : []) {
    const a = attrsOf(f)
    if (a['@numFmtId'] !== undefined && a['@formatCode'] !== undefined)
      custom.set(Number(a['@numFmtId']), a['@formatCode'])
  }
  const xfs = find(doc, 'cellXfs')
  const kind: Styles['kind'] = []
  for (const xf of xfs ? childrenOf(xfs).filter((n) => tagOf(n) === 'xf') : []) {
    const id = Number(attrsOf(xf)['@numFmtId'] ?? 0)
    const code = custom.get(id)
    if (code !== undefined) {
      if (/%/.test(bareFormat(code))) kind.push('percent')
      else if (isDateFormat(code)) kind.push(isTimeFormat(code) ? 'datetime' : 'date')
      else kind.push(undefined)
    } else if (BUILTIN_PERCENT_FORMATS.has(id)) kind.push('percent')
    else if (BUILTIN_DATE_FORMATS.has(id)) kind.push(BUILTIN_TIME_FORMATS.has(id) ? 'datetime' : 'date')
    else kind.push(undefined)
  }
  return { kind }
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const doc = xmlParser.parse(xml) as XNode[]
  const sst = find(doc, 'sst')
  const out: string[] = []
  for (const si of sst ? childrenOf(sst).filter((n) => tagOf(n) === 'si') : []) {
    let text = ''
    for (const n of walk(childrenOf(si))) {
      // Phonetic guides (rPh) are not part of the cell text.
      if (tagOf(n) === 'rPh') continue
      if (tagOf(n) === 't') text += textOf(n)
    }
    out.push(text)
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** An Excel serial date as ISO text (1900 system by default, with its phantom 29 February). */
export function serialToIso(serial: number, options: { time?: boolean; date1904?: boolean } = {}): string {
  const epoch = options.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const days = Math.floor(serial)
  const fraction = serial - days
  const ms = epoch + days * 86_400_000 + Math.round(fraction * 86_400_000)
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  if (!options.time) return date
  if (days === 0) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** Numbers as a person would type them: no float noise, no exponent for everyday magnitudes. */
export function formatNumber(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const fixed = Number(n.toPrecision(12))
  return String(fixed)
}

interface SheetCells {
  rows: Map<number, Map<number, Cell>>
  merges: Array<{ r0: number; c0: number; r1: number; c1: number }>
}

function parseSheet(xml: string, shared: string[], styles: Styles, date1904: boolean): SheetCells {
  const doc = xmlParser.parse(xml) as XNode[]
  const rows = new Map<number, Map<number, Cell>>()
  const sheetData = find(doc, 'sheetData')
  let rowIndex = -1
  for (const row of sheetData ? childrenOf(sheetData).filter((n) => tagOf(n) === 'row') : []) {
    const rAttr = attrsOf(row)['@r']
    rowIndex = rAttr !== undefined ? Number(rAttr) - 1 : rowIndex + 1
    let colIndex = -1
    const cells = new Map<number, Cell>()
    for (const c of childrenOf(row).filter((n) => tagOf(n) === 'c')) {
      const a = attrsOf(c)
      colIndex = a['@r'] !== undefined ? columnIndex(a['@r']) : colIndex + 1
      const text = cellText(c, a, shared, styles, date1904)
      if (text !== '') cells.set(colIndex, { text })
    }
    if (cells.size > 0) rows.set(rowIndex, cells)
  }
  const merges: SheetCells['merges'] = []
  const mergeCells = find(doc, 'mergeCells')
  for (const m of mergeCells ? childrenOf(mergeCells) : []) {
    const ref = attrsOf(m)['@ref']
    const parts = ref?.split(':')
    if (!parts || parts.length !== 2) continue
    const [from, to] = parts as [string, string]
    const rowOf = (s: string) => Number(s.replace(/^[A-Z]+/, '')) - 1
    merges.push({ r0: rowOf(from), c0: columnIndex(from), r1: rowOf(to), c1: columnIndex(to) })
  }
  return { rows, merges }
}

function cellText(
  c: XNode,
  a: Record<string, string>,
  shared: string[],
  styles: Styles,
  date1904: boolean,
): string {
  const type = a['@t'] ?? 'n'
  const children = childrenOf(c)
  if (type === 'inlineStr') {
    const is = children.find((n) => tagOf(n) === 'is')
    return is ? textOf(is).trim() : ''
  }
  const v = children.find((n) => tagOf(n) === 'v')
  const raw = v ? textOf(v) : ''
  if (raw === '') return ''
  switch (type) {
    case 's':
      return (shared[Number(raw)] ?? '').trim()
    case 'str':
      return raw.trim()
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE'
    case 'e':
      return raw
    case 'd':
      return raw
    default: {
      const kind = a['@s'] !== undefined ? styles.kind[Number(a['@s'])] : undefined
      const n = Number(raw)
      if (!Number.isFinite(n)) return raw
      if (kind === 'date' || kind === 'datetime')
        return serialToIso(n, { time: kind === 'datetime', date1904 })
      if (kind === 'percent') return `${formatNumber(String(Math.round(n * 100 * 100) / 100))}%`
      return formatNumber(raw)
    }
  }
}

const mdCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/**
 * Markdown of one sheet. Blank rows split blocks of cells; blocks one blank row apart that share
 * their columns are one table with a spacer row. A single column is a list; rows above a table
 * that hold one value (a title, a note) are paragraphs.
 */
export function sheetToMarkdown(cells: SheetCells): string {
  const grid = new Map<number, Map<number, string>>()
  for (const [r, row] of cells.rows) grid.set(r, new Map([...row].map(([c, cell]) => [c, cell.text])))
  // Merged ranges repeat their top-left value so every cell of the table reads on its own.
  for (const m of cells.merges) {
    const value = grid.get(m.r0)?.get(m.c0)
    if (value === undefined) continue
    for (let r = m.r0; r <= m.r1; r++) {
      const row = grid.get(r) ?? new Map<number, string>()
      for (let c = m.c0; c <= m.c1; c++) if (!row.has(c)) row.set(c, value)
      grid.set(r, row)
    }
  }
  const extent = (rows: number[]) => {
    let c0 = Number.POSITIVE_INFINITY
    let c1 = Number.NEGATIVE_INFINITY
    for (const r of rows)
      for (const c of (grid.get(r) as Map<number, string>).keys()) {
        c0 = Math.min(c0, c)
        c1 = Math.max(c1, c)
      }
    return { c0, c1 }
  }
  const rowNumbers = [...grid.keys()].sort((a, b) => a - b)
  const blocks: number[][] = []
  for (const r of rowNumbers) {
    const last = blocks[blocks.length - 1]
    const gap = last ? r - (last[last.length - 1] as number) : Number.POSITIVE_INFINITY
    if (last && gap <= 1) last.push(r)
    else if (last && gap === 2) {
      // One blank row inside a table is a spacer; a narrower block starting there is a new one.
      const a = extent(last)
      const b = extent([r])
      if (b.c0 === a.c0 && b.c1 <= a.c1 && b.c1 - b.c0 + 1 >= (a.c1 - a.c0 + 1) / 2) last.push(r)
      else blocks.push([r])
    } else blocks.push([r])
  }
  const out: string[] = []
  for (const block of blocks) {
    const rows = block.map((r) => grid.get(r) as Map<number, string>)
    const { c0, c1 } = extent(block)
    const width = c1 - c0 + 1
    if (width === 1) {
      out.push(rows.map((row) => `- ${mdCell(row.get(c0) ?? '')}`).join('\n'))
      continue
    }
    const line = (row: Map<number, string>) =>
      `| ${Array.from({ length: width }, (_, i) => mdCell(row.get(c0 + i) ?? '')).join(' | ')} |`
    const lone = (row: Map<number, string>) => new Set(row.values()).size === 1
    let start = 0
    while (start < rows.length && lone(rows[start] as Map<number, string>)) {
      const [text] = (rows[start] as Map<number, string>).values()
      out.push(mdCell(text ?? ''))
      start++
    }
    const table = rows.slice(start)
    if (table.length === 0) continue
    out.push(
      [line(table[0] as Map<number, string>), `|${' --- |'.repeat(width)}`, ...table.slice(1).map(line)].join(
        '\n',
      ),
    )
  }
  return out.join('\n\n')
}

/** Converts a .xlsx workbook to markdown with one `<!-- page N -->` section per visible sheet. */
export async function xlsxToMarkdown(bytes: Uint8Array): Promise<XlsxResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new RagChunkerError('INPUT_INVALID', `Could not read XLSX: ${(err as Error).message}`, {
      cause: err,
    })
  }
  const workbook = await zip.file('xl/workbook.xml')?.async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!workbook || !rels)
    throw new RagChunkerError('INPUT_INVALID', 'Not an Excel file (missing xl/workbook.xml)')
  const shared = parseSharedStrings(await zip.file('xl/sharedStrings.xml')?.async('string'))
  const styles = parseStyles(await zip.file('xl/styles.xml')?.async('string'))
  const doc = xmlParser.parse(workbook) as XNode[]
  const pr = find(doc, 'workbookPr')
  const date1904 = pr ? /^(1|true)$/i.test(attrsOf(pr)['@date1904'] ?? '') : false
  const targets = relTargets(rels)
  const sheets = find(doc, 'sheets')
  const warnings: string[] = []
  const sections: string[] = []
  let pageNumber = 0
  for (const sheet of sheets ? childrenOf(sheets).filter((n) => tagOf(n) === 'sheet') : []) {
    const a = attrsOf(sheet)
    const name = a['@name'] ?? `Sheet ${pageNumber + 1}`
    if (a['@state'] === 'hidden' || a['@state'] === 'veryHidden') {
      warnings.push(`XLSX: hidden sheet "${name}" skipped`)
      continue
    }
    const target = a['@r:id'] ? targets.get(a['@r:id']) : undefined
    const path = target ? resolvePath('xl/workbook.xml', target) : undefined
    const xml = path ? await zip.file(path)?.async('string') : undefined
    pageNumber++
    const body = xml ? sheetToMarkdown(parseSheet(xml, shared, styles, date1904)) : ''
    sections.push(`<!-- page ${pageNumber} -->\n\n## ${name}${body ? `\n\n${body}` : ''}`)
  }
  if (pageNumber === 0) throw new RagChunkerError('INPUT_INVALID', 'The workbook has no visible sheets')
  return { markdown: sections.join('\n\n'), sheetCount: pageNumber, warnings }
}
