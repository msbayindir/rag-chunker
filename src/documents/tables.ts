import type { ModelCell, ModelTable } from '../local/table.js'

/**
 * Tables in the PDF text layer. Three detectors run in order: grids drawn with horizontal and
 * vertical lines, tables bounded by horizontal rules only (booktabs-style papers) whose columns
 * come from text alignment, and tables with no lines at all, found from aligned columns of short
 * cells. Coordinates are PDF user space (points, y up).
 */

export interface TableCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  text: string
}

export interface TableData {
  rows: number
  cols: number
  /** Leading rows that form the header (at least 1 when the table has rows). */
  headerRows: number
  /** One entry per visible cell; positions covered by a span have no entry of their own. */
  cells: TableCell[]
  /**
   * How the table was recognised: a drawn grid, the table-structure model, horizontal rules +
   * alignment, or alignment alone.
   */
  source: 'ruled' | 'model' | 'rules' | 'aligned'
  /** True when the table continues one that ended at the bottom of the previous page. */
  continuation?: boolean
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A horizontal (y0 === y1) or vertical (x0 === x1) line on the page. */
export type Segment = Rect

export interface Rulings {
  h: Segment[]
  v: Segment[]
}

/** A piece of text on one baseline; `items` are the glyph runs it was built from. */
export interface TextPiece {
  text: string
  x0: number
  x1: number
  y: number
  size: number
  items?: ReadonlyArray<{ str: string; x: number; width: number; size: number }>
}

export interface DetectedTable {
  data: TableData
  bbox: Rect
  /** A title row that spanned the whole grid, emitted as a paragraph above the table. */
  caption?: { text: string; bbox: Rect }
}

// pdf.js operator codes (stable across releases) and the path commands inside constructPath.
const OP = {
  save: 10,
  restore: 11,
  transform: 12,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91,
} as const
const PATH = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const
const STROKES = new Set<number>([
  OP.stroke,
  OP.closeStroke,
  OP.fillStroke,
  OP.eoFillStroke,
  OP.closeFillStroke,
  OP.closeEOFillStroke,
])
const FILLS = new Set<number>([
  OP.fill,
  OP.eoFill,
  OP.fillStroke,
  OP.eoFillStroke,
  OP.closeFillStroke,
  OP.closeEOFillStroke,
])

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `a` applied after `b` (what the canvas `transform()` call does to the current matrix). */
function compose(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Minimum length of a line that counts as a ruling, and the thickness below which a filled rectangle is one. */
const MIN_RULE = 3
const MAX_RULE_THICKNESS = 2.5
const TOL = 2

interface OperatorList {
  fnArray: number[]
  argsArray: unknown[]
}

/** Horizontal and vertical lines drawn on a page: stroked paths and thin filled rectangles. */
export async function extractRulings(page: { getOperatorList(): Promise<OperatorList> }): Promise<Rulings> {
  const ops = await page.getOperatorList()
  const h: Segment[] = []
  const v: Segment[] = []
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []

  const addPolyline = (points: Array<[number, number]>, paintOp: number) => {
    if (points.length < 2) return
    if (STROKES.has(paintOp)) {
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1] as [number, number]
        const [bx, by] = points[i] as [number, number]
        if (Math.abs(ay - by) <= 0.5 && Math.abs(ax - bx) >= MIN_RULE) {
          h.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: (ay + by) / 2, y1: (ay + by) / 2 })
        } else if (Math.abs(ax - bx) <= 0.5 && Math.abs(ay - by) >= MIN_RULE) {
          v.push({ x0: (ax + bx) / 2, x1: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) })
        }
      }
    }
    if (FILLS.has(paintOp)) {
      // A thin filled rectangle is a rule (the common way to draw table borders).
      const xs = points.map((p) => p[0])
      const ys = points.map((p) => p[1])
      const x0 = Math.min(...xs)
      const x1 = Math.max(...xs)
      const y0 = Math.min(...ys)
      const y1 = Math.max(...ys)
      const w = x1 - x0
      const hh = y1 - y0
      const rectangular = points.every(
        (p) =>
          (Math.abs(p[0] - x0) < 0.5 || Math.abs(p[0] - x1) < 0.5) &&
          (Math.abs(p[1] - y0) < 0.5 || Math.abs(p[1] - y1) < 0.5),
      )
      if (!rectangular) return
      if (hh <= MAX_RULE_THICKNESS && w >= MIN_RULE) h.push({ x0, x1, y0: (y0 + y1) / 2, y1: (y0 + y1) / 2 })
      else if (w <= MAX_RULE_THICKNESS && hh >= MIN_RULE)
        v.push({ x0: (x0 + x1) / 2, x1: (x0 + x1) / 2, y0, y1 })
    }
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i] as unknown[] | null
    switch (fn) {
      case OP.save:
        stack.push(ctm)
        break
      case OP.restore:
        ctm = stack.pop() ?? IDENTITY
        break
      case OP.transform:
        if (args && args.length >= 6) ctm = compose(ctm, args.slice(0, 6).map(Number) as Matrix)
        break
      case OP.paintFormXObjectBegin: {
        stack.push(ctm)
        const m = Array.isArray(args?.[0]) ? (args[0] as number[]) : null
        if (m && m.length >= 6) ctm = compose(ctm, m.slice(0, 6).map(Number) as Matrix)
        break
      }
      case OP.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY
        break
      case OP.rectangle: {
        if (!args || args.length < 4) break
        const [x, y, w, hh] = args.map(Number) as [number, number, number, number]
        const pts: Array<[number, number]> = [
          apply(ctm, x, y),
          apply(ctm, x + w, y),
          apply(ctm, x + w, y + hh),
          apply(ctm, x, y + hh),
          apply(ctm, x, y),
        ]
        addPolyline(pts, OP.fillStroke)
        break
      }
      case OP.constructPath: {
        if (!args || args.length < 2) break
        const paintOp = Number(args[0])
        const data = args[1]
        // pdf.js hands the path as one flat command list or as a list of them (typed or plain arrays).
        const parts: unknown[] = Array.isArray(data) ? data : [data]
        const segments: number[][] = parts.every((x) => typeof x === 'number')
          ? [parts as number[]]
          : parts.map((x) => Array.from(x as ArrayLike<number>))

        for (const d of segments) {
          let pts: Array<[number, number]> = []
          let start: [number, number] | null = null
          const flush = () => {
            addPolyline(pts, paintOp)
            pts = []
          }
          for (let k = 0; k < d.length; ) {
            const cmd = d[k++]
            if (cmd === PATH.moveTo) {
              if (pts.length > 1) flush()
              else pts = []
              const p = apply(ctm, d[k++] as number, d[k++] as number)
              pts.push(p)
              start = p
            } else if (cmd === PATH.lineTo) {
              pts.push(apply(ctm, d[k++] as number, d[k++] as number))
            } else if (cmd === PATH.curveTo) {
              k += 4
              pts.push(apply(ctm, d[k++] as number, d[k++] as number))
            } else if (cmd === PATH.quadraticCurveTo) {
              k += 2
              pts.push(apply(ctm, d[k++] as number, d[k++] as number))
            } else if (cmd === PATH.closePath) {
              if (start) pts.push(start)
              flush()
            } else {
              break
            }
          }
          flush()
        }
        break
      }
      default:
        break
    }
  }
  return { h: mergeSegments(h, 'h'), v: mergeSegments(v, 'v') }
}

/** Joins collinear, overlapping or touching segments. */
export function mergeSegments(segments: Segment[], axis: 'h' | 'v'): Segment[] {
  const pos = (s: Segment) => (axis === 'h' ? s.y0 : s.x0)
  const lo = (s: Segment) => (axis === 'h' ? s.x0 : s.y0)
  const hi = (s: Segment) => (axis === 'h' ? s.x1 : s.y1)
  const sorted = [...segments].sort((a, b) => pos(a) - pos(b) || lo(a) - lo(b))
  const out: Segment[] = []
  let group: Segment[] = []
  const flush = () => {
    if (group.length === 0) return
    const p = group.reduce((s, g) => s + pos(g), 0) / group.length
    group.sort((a, b) => lo(a) - lo(b))
    let a = lo(group[0] as Segment)
    let b = hi(group[0] as Segment)
    const emit = () =>
      out.push(axis === 'h' ? { x0: a, x1: b, y0: p, y1: p } : { x0: p, x1: p, y0: a, y1: b })
    for (const g of group.slice(1)) {
      if (lo(g) <= b + TOL) b = Math.max(b, hi(g))
      else {
        emit()
        a = lo(g)
        b = hi(g)
      }
    }
    emit()
    group = []
  }
  for (const s of sorted) {
    const last = group.at(-1)
    if (last && Math.abs(pos(s) - pos(last)) > 1) flush()
    group.push(s)
  }
  flush()
  return out
}

function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  let group: number[] = []
  for (const v of sorted) {
    if (group.length > 0 && v - (group.at(-1) as number) > tol) {
      out.push(group.reduce((s, g) => s + g, 0) / group.length)
      group = []
    }
    group.push(v)
  }
  if (group.length > 0) out.push(group.reduce((s, g) => s + g, 0) / group.length)
  return out
}

const centerY = (p: TextPiece) => p.y + p.size * 0.35
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i] as number] as number
      i = this.parent[i] as number
    }
    return i
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b)
  }
}

/** Tables drawn as grids: components of crossing horizontal and vertical lines with at least two columns. */
function ruledTables(
  pieces: TextPiece[],
  rulings: Rulings,
): { tables: DetectedTable[]; used: Set<TextPiece>; regions: Rect[] } {
  const { h, v } = rulings
  const uf = new UnionFind(h.length + v.length)
  for (let i = 0; i < h.length; i++) {
    const hs = h[i] as Segment
    for (let j = 0; j < v.length; j++) {
      const vs = v[j] as Segment
      if (vs.x0 >= hs.x0 - TOL && vs.x0 <= hs.x1 + TOL && hs.y0 >= vs.y0 - TOL && hs.y0 <= vs.y1 + TOL)
        uf.union(i, h.length + j)
    }
  }
  const groups = new Map<number, { h: Segment[]; v: Segment[] }>()
  h.forEach((s, i) => {
    const g = groups.get(uf.find(i)) ?? { h: [], v: [] }
    g.h.push(s)
    groups.set(uf.find(i), g)
  })
  v.forEach((s, j) => {
    const g = groups.get(uf.find(h.length + j)) ?? { h: [], v: [] }
    g.v.push(s)
    groups.set(uf.find(h.length + j), g)
  })

  const tables: DetectedTable[] = []
  const used = new Set<TextPiece>()
  const regions: Rect[] = []
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 3) continue
    const rowY = cluster(
      g.h.map((s) => s.y0),
      TOL,
    ).sort((a, b) => b - a)
    const colX = cluster(
      g.v.map((s) => s.x0),
      TOL,
    ).sort((a, b) => a - b)
    if (rowY.length < 2 || colX.length < 3) continue
    const nRows = rowY.length - 1
    const nCols = colX.length - 1
    // Diagrams are grids too: many tiny cells and almost no text. Real tables are modest and filled.
    if (nRows < 2 || nCols < 2 || nCols > 24) continue
    const bbox: Rect = {
      x0: colX[0] as number,
      x1: colX.at(-1) as number,
      y0: rowY.at(-1) as number,
      y1: rowY[0] as number,
    }

    const hasVBorder = (c: number, r: number) => {
      const x = colX[c] as number
      const top = rowY[r] as number
      const bottom = rowY[r + 1] as number
      return g.v.some(
        (s) => Math.abs(s.x0 - x) <= TOL && overlap(s.y0, s.y1, bottom, top) >= (top - bottom) * 0.5,
      )
    }
    const hasHBorder = (r: number, c: number) => {
      const y = rowY[r] as number
      const left = colX[c] as number
      const right = colX[c + 1] as number
      return g.h.some(
        (s) => Math.abs(s.y0 - y) <= TOL && overlap(s.x0, s.x1, left, right) >= (right - left) * 0.5,
      )
    }

    // Grid cells merge across missing borders into spanning cells.
    const owner: number[][] = Array.from({ length: nRows }, () => new Array<number>(nCols).fill(-1))
    const cells: Array<TableCell & { texts: Array<{ x: number; y: number; text: string }> }> = []
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < nCols; c++) {
        if ((owner[r] as number[])[c] !== -1) continue
        let colSpan = 1
        while (
          c + colSpan < nCols &&
          !hasVBorder(c + colSpan, r) &&
          (owner[r] as number[])[c + colSpan] === -1
        )
          colSpan++
        let rowSpan = 1
        while (r + rowSpan < nRows) {
          let open = true
          for (let cc = c; cc < c + colSpan; cc++) {
            if (hasHBorder(r + rowSpan, cc) || (owner[r + rowSpan] as number[])[cc] !== -1) open = false
          }
          if (!open) break
          rowSpan++
        }
        const id = cells.length
        for (let rr = r; rr < r + rowSpan; rr++)
          for (let cc = c; cc < c + colSpan; cc++) (owner[rr] as number[])[cc] = id
        cells.push({ row: r, col: c, rowSpan, colSpan, text: '', texts: [] })
      }
    }

    let any = false
    const pieceOf = new Map<{ x: number; y: number; text: string }, TextPiece>()
    for (const p of pieces) {
      const cy = centerY(p)
      if (cy < bbox.y0 - TOL || cy > bbox.y1 + TOL) continue
      // A line can run through several cells; each run of glyphs lands in its own cell.
      for (const part of splitPiece(p, 0.7)) {
        const cx = (part.x0 + part.x1) / 2
        if (cx < bbox.x0 - TOL || cx > bbox.x1 + TOL) continue
        let r = rowY.findIndex((y, i) => i < nRows && cy <= y + TOL && cy > (rowY[i + 1] as number))
        let c = colX.findIndex((x, i) => i < nCols && cx >= x - TOL && cx < (colX[i + 1] as number))
        if (r === -1) r = cy > (rowY[0] as number) ? 0 : nRows - 1
        if (c === -1) c = cx < (colX[0] as number) ? 0 : nCols - 1
        const cell = cells[(owner[r] as number[])[c] as number]
        if (!cell) continue
        const entry = { x: part.x0, y: p.y, text: part.text }
        pieceOf.set(entry, p)
        cell.texts.push(entry)
        used.add(p)
        any = true
      }
    }
    if (!any) continue
    for (const cell of cells) {
      cell.texts.sort((a, b) => b.y - a.y || a.x - b.x)
      cell.text = cell.texts
        .map((t) => t.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
    if (cells.filter((c) => c.text !== '').length < cells.length * 0.25) {
      for (const cell of cells) for (const t of cell.texts) used.delete(pieceOf.get(t) as TextPiece)
      continue
    }
    regions.push(bbox)
    let rows = nRows
    let body = cells.map(({ texts: _texts, ...cell }) => cell)
    let tableBox = bbox
    let caption: DetectedTable['caption']
    // A first row that is one cell across the whole grid is the table's title, not a header.
    const first = body.find((c) => c.row === 0)
    if (
      rows >= 3 &&
      first &&
      first.colSpan === nCols &&
      first.rowSpan === 1 &&
      body.filter((c) => c.row === 0).length === 1
    ) {
      caption = {
        text: first.text,
        bbox: { x0: bbox.x0, x1: bbox.x1, y0: rowY[1] as number, y1: rowY[0] as number },
      }
      body = body.filter((c) => c.row > 0).map((c) => ({ ...c, row: c.row - 1 }))
      rows--
      tableBox = { ...bbox, y1: rowY[1] as number }
    }
    // Header rows: the first row plus every row a header cell spans into (two-level headers).
    let headerRows = 1
    while (
      headerRows < rows - 1 &&
      headerRows < 3 &&
      body.some((c) => c.row < headerRows && c.row + c.rowSpan > headerRows)
    )
      headerRows++
    tables.push({
      bbox: tableBox,
      ...(caption ? { caption } : {}),
      data: { rows, cols: nCols, headerRows, cells: body, source: 'ruled' },
    })
  }
  return { tables, used, regions }
}

interface AlignOptions {
  /** Gap (in em) that separates two cells on one line; below the piece's own segmentation when items are known. */
  gapEm: number
  minCols: number
  minRows: number
  /** Rows of the header; called with the row baselines (top first). */
  headerRows?: (rowYs: number[]) => number
  /** Share of rows that must have (almost) every column filled, and how many such rows at least. */
  fullShare: number
  minFullRows: number
  /** Median cell length (characters) above which the block is prose, not a table. */
  maxMedianLength: number
  /** Widest cell allowed, in points. */
  maxCellWidth: number
  pageWidth: number
}

interface RowCell {
  x0: number
  x1: number
  text: string
}

/** Splits a piece into cells at gaps wider than `gapEm` ems, using its glyph runs when available. */
function splitPiece(piece: TextPiece, gapEm: number): RowCell[] {
  if (!piece.items || piece.items.length === 0) return [{ x0: piece.x0, x1: piece.x1, text: piece.text }]
  const items = [...piece.items].filter((it) => it.str.trim() !== '').sort((a, b) => a.x - b.x)
  // Some fonts (math, Type3) report no glyph widths; estimate them so gaps are not inflated.
  const widthOf = (it: { str: string; width: number; size: number }) =>
    it.width > 0 ? it.width : it.str.trim().length * it.size * 0.55
  const cells: RowCell[] = []
  let cur: { x0: number; x1: number; parts: string[] } | null = null
  for (const it of items) {
    const gap = cur ? it.x - cur.x1 : 0
    if (!cur || gap > Math.max(gapEm * it.size, 3)) {
      if (cur) cells.push({ x0: cur.x0, x1: cur.x1, text: cur.parts.join(' ') })
      cur = { x0: it.x, x1: it.x + widthOf(it), parts: [it.str.trim()] }
    } else {
      cur.parts.push(it.str.trim())
      cur.x1 = Math.max(cur.x1, it.x + widthOf(it))
    }
  }
  if (cur) cells.push({ x0: cur.x0, x1: cur.x1, text: cur.parts.join(' ') })
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text !== '')
}

/**
 * Column boundaries from the whitespace profile: an x position no cell of (almost) any row covers is
 * a gap between columns, whatever the alignment of the cells; runs of such positions at least
 * `minGap` wide separate the columns. Spanning headers cover a gap in a few rows only.
 */
function columnBounds(
  rows: Array<{ cells: RowCell[] }>,
  minX: number,
  maxX: number,
  minGap: number,
): number[] {
  const width = Math.ceil(maxX - minX) + 1
  const coverage = new Array<number>(width).fill(0)
  for (const row of rows) {
    for (const c of row.cells) {
      const a = Math.max(0, Math.floor(c.x0 - minX))
      const b = Math.min(width - 1, Math.ceil(c.x1 - minX))
      for (let x = a; x <= b; x++) (coverage[x] as number)++
    }
  }
  const limit = rows.length * 0.25
  const bounds = [minX - 1]
  let runStart = -1
  for (let x = 0; x <= width; x++) {
    const free = x < width && (coverage[x] as number) <= limit
    if (free && runStart === -1) runStart = x
    if (!free && runStart !== -1) {
      if (x - runStart >= minGap && runStart > 0) bounds.push(minX + (runStart + x) / 2)
      runStart = -1
    }
  }
  bounds.push(maxX + 1)
  return bounds
}

/** Columns from text alignment (see `columnBounds`); cells join the column under their centre. */
function alignTable(pieces: TextPiece[], opts: AlignOptions): DetectedTable | null {
  if (pieces.length === 0) return null
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x0 - b.x0)
  const rows: Array<{ y: number; size: number; cells: RowCell[] }> = []
  for (const p of sorted) {
    const row = rows.at(-1)
    if (row && Math.abs(row.y - p.y) <= Math.max(2, p.size * 0.45))
      row.cells.push(...splitPiece(p, opts.gapEm))
    else rows.push({ y: p.y, size: p.size, cells: splitPiece(p, opts.gapEm) })
  }
  for (const row of rows) row.cells.sort((a, b) => a.x0 - b.x0)
  if (rows.length < opts.minRows) return null

  const minX = Math.min(...rows.flatMap((r) => r.cells.map((c) => c.x0)))
  const maxX = Math.max(...rows.flatMap((r) => r.cells.map((c) => c.x1)))
  const size = rows.map((r) => r.size).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 10
  const bounds = columnBounds(rows, minX, maxX, Math.max(opts.gapEm * size * 0.8, 3))
  let cols = bounds.length - 1
  if (cols < opts.minCols) return null

  const colOf = (cx: number) => {
    for (let c = 0; c < cols; c++) if (cx >= (bounds[c] as number) && cx < (bounds[c + 1] as number)) return c
    return cx < (bounds[0] as number) ? 0 : cols - 1
  }
  const spanOf = (cell: RowCell, col: number) => {
    let span = 1
    for (let c = col + 1; c < cols; c++) {
      const b0 = bounds[c] as number
      const b1 = bounds[c + 1] as number
      if (overlap(cell.x0, cell.x1, b0, b1) >= (b1 - b0) * 0.6) span++
      else break
    }
    return span
  }

  type Placed = { col: number; span: number; text: string }
  const placedRows: Array<{ y: number; cells: Map<number, Placed> }> = rows.map((row) => {
    const cells = new Map<number, Placed>()
    for (const cell of row.cells) {
      const col = colOf((cell.x0 + cell.x1) / 2)
      const existing = cells.get(col)
      if (existing) existing.text = `${existing.text} ${cell.text}`
      else cells.set(col, { col, span: spanOf(cell, col), text: cell.text })
    }
    return { y: row.y, cells }
  })

  // Wrapped cell text shows up as a short row with an empty first column right above or below
  // the row it belongs to ("Commonsense" over "Reasoning"; a second line under a long cell).
  const gaps = placedRows
    .slice(1)
    .map((r, i) => (placedRows[i] as (typeof placedRows)[number]).y - r.y)
    .filter((g) => g > 0)
    .sort((a, b) => a - b)
  const lineGap = gaps[Math.floor(gaps.length / 2)] ?? 12
  const isPartial = (r: (typeof placedRows)[number]) =>
    r.cells.size < cols && !r.cells.has(0) && r.cells.size > 0
  const merged: typeof placedRows = []
  for (let i = 0; i < placedRows.length; i++) {
    const row = placedRows[i] as (typeof placedRows)[number]
    const prev = merged.at(-1)
    const next = placedRows[i + 1]
    if (isPartial(row)) {
      if (next && !isPartial(next) && next.cells.size > row.cells.size && row.y - next.y <= lineGap * 1.4) {
        for (const [col, cell] of row.cells) {
          const target = next.cells.get(col)
          if (target) target.text = `${cell.text} ${target.text}`
          else next.cells.set(col, cell)
        }
        continue
      }
      if (prev && prev.y - row.y <= lineGap * 1.4) {
        for (const [col, cell] of row.cells) {
          const target = prev.cells.get(col)
          if (target) target.text = `${target.text} ${cell.text}`
          else prev.cells.set(col, cell)
        }
        continue
      }
    }
    merged.push(row)
  }
  // Columns nothing ever lands in (a rule wider than the text) are dropped.
  const usedCols = [...new Set(merged.flatMap((r) => [...r.cells.keys()]))].sort((a, b) => a - b)
  if (usedCols.length < cols) {
    const remap = new Map(usedCols.map((c, i) => [c, i]))
    for (const r of merged) {
      const cells = new Map<number, Placed>()
      for (const [c, cell] of r.cells) {
        const nc = remap.get(c) as number
        cells.set(nc, { ...cell, col: nc, span: Math.min(cell.span, usedCols.length - nc) })
      }
      r.cells = cells
    }
    cols = usedCols.length
    if (cols < opts.minCols) return null
  }
  if (merged.length < opts.minRows) return null

  // Prose between rules (page bodies between header and footer lines, boxed paragraphs) has long,
  // single-cell rows; tables have short cells in most columns of most rows.
  const full = merged.filter((r) => r.cells.size >= Math.max(2, Math.ceil(cols * 0.6))).length
  if (full < Math.max(opts.minFullRows, merged.length * opts.fullShare))
    return reject('sparse rows', merged, cols)
  const lengths = merged.flatMap((r) => [...r.cells.values()].map((c) => c.text.length)).sort((a, b) => a - b)
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0
  if (median > opts.maxMedianLength || (cols === 2 && median > 30)) return reject('long cells', merged, cols)
  if (rows.some((r) => r.cells.some((c) => c.x1 - c.x0 > opts.maxCellWidth)))
    return reject('wide cell', merged, cols)

  const cells: TableCell[] = []
  merged.forEach((row, r) => {
    for (const cell of [...row.cells.values()].sort((a, b) => a.col - b.col)) {
      cells.push({
        row: r,
        col: cell.col,
        rowSpan: 1,
        colSpan: cell.span,
        text: cell.text.replace(/\s+/g, ' ').trim(),
      })
    }
  })
  const top = Math.max(...pieces.map((p) => p.y + p.size * 0.8))
  const bottom = Math.min(...pieces.map((p) => p.y - p.size * 0.25))
  const headerRows = Math.min(merged.length, Math.max(1, opts.headerRows?.(merged.map((r) => r.y)) ?? 1))
  return {
    bbox: { x0: minX, x1: maxX, y0: bottom, y1: top },
    data: { rows: merged.length, cols, headerRows, cells, source: 'aligned' },
  }
}

function reject(reason: string, rows: Array<{ cells: Map<number, { text: string }> }>, cols: number): null {
  if (process.env.RAG_CHUNKER_TABLE_DEBUG) {
    const first = rows[0] ? [...rows[0].cells.values()].map((c) => c.text).join(' | ') : ''
    console.error(`[tables] rejected (${reason}): ${rows.length} rows x ${cols} cols: ${first.slice(0, 100)}`)
    if (process.env.RAG_CHUNKER_TABLE_DEBUG === '2')
      for (const r of rows)
        console.error(
          `    ${[...r.cells.entries()].map(([c, v]) => `${c}:${v.text.slice(0, 18)}`).join(' | ')}`,
        )
  }
  return null
}

const inRect = (p: TextPiece, r: Rect, tol = TOL) => {
  const cx = (p.x0 + p.x1) / 2
  const cy = centerY(p)
  return cx >= r.x0 - tol && cx <= r.x1 + tol && cy >= r.y0 - tol && cy <= r.y1 + tol
}

/** Tables between horizontal rules (no vertical lines): columns come from alignment. */
function ruleBoundedTables(
  pieces: TextPiece[],
  rulings: Rulings,
  pageWidth: number,
  exclude: Rect[],
): { tables: DetectedTable[]; used: Set<TextPiece> } {
  const rules = rulings.h
    .filter((s) => s.x1 - s.x0 >= pageWidth * 0.2)
    .filter(
      (s) =>
        !exclude.some((r) => s.y0 >= r.y0 - TOL && s.y0 <= r.y1 + TOL && overlap(s.x0, s.x1, r.x0, r.x1) > 0),
    )
    .sort((a, b) => b.y0 - a.y0)
  const tables: DetectedTable[] = []
  const used = new Set<TextPiece>()
  const taken = new Set<Segment>()
  // Rows between two rules look tabular when most of them split into two or more cells.
  const tabularBand = (upper: Segment, lower: Segment): boolean => {
    const band: Rect = {
      x0: Math.min(upper.x0, lower.x0),
      x1: Math.max(upper.x1, lower.x1),
      y0: lower.y0,
      y1: upper.y0,
    }
    const rows = new Map<number, number>()
    for (const p of pieces) {
      if (used.has(p) || !inRect(p, band, 4)) continue
      const key = Math.round(p.y / 3)
      rows.set(key, (rows.get(key) ?? 0) + splitPiece(p, 0.7).length)
    }
    if (rows.size === 0) return upper.y0 - lower.y0 <= 30
    return [...rows.values()].filter((n) => n >= 2).length >= rows.size * 0.5
  }
  const overlapping = (a: Segment, b: Segment) =>
    overlap(a.x0, a.x1, b.x0, b.x1) >= Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5

  for (const top of rules) {
    if (taken.has(top)) continue
    // Walk down rule by rule while the band in between still looks like table rows: the chain is
    // the table; a band of prose (caption, notes, body text) ends it.
    const chain = [top]
    let cur = top
    for (;;) {
      const next = rules.find((s) => !taken.has(s) && s.y0 < cur.y0 - 1 && overlapping(s, cur))
      if (!next || !tabularBand(cur, next)) break
      chain.push(next)
      cur = next
    }
    for (const s of chain) taken.add(s)
    if (chain.length < 2) continue
    const region: Rect = {
      x0: Math.min(...chain.map((s) => s.x0)),
      x1: Math.max(...chain.map((s) => s.x1)),
      y0: cur.y0,
      y1: top.y0,
    }
    const inside = pieces.filter((p) => !used.has(p) && inRect(p, region, 4))
    if (inside.length === 0) continue
    const inner = chain.filter((s) => s.y0 < region.y1 - 1 && s.y0 > region.y0 + 1).map((s) => s.y0)
    const table = alignTable(inside, {
      gapEm: 0.7,
      minCols: 2,
      minRows: 2,
      fullShare: 0.5,
      minFullRows: 2,
      maxMedianLength: 60,
      maxCellWidth: (region.x1 - region.x0) * 0.7,
      pageWidth,
      headerRows: (ys) => {
        const first = Math.max(...inner.filter((y) => y < (ys[0] as number)), Number.NEGATIVE_INFINITY)
        if (!Number.isFinite(first)) return 1
        return Math.min(3, ys.filter((y) => y > first).length)
      },
    })
    if (!table) continue
    table.data.source = 'rules'
    table.bbox = { ...region, y0: Math.min(region.y0, table.bbox.y0), y1: Math.max(region.y1, table.bbox.y1) }
    for (const p of inside) used.add(p)
    tables.push(table)
  }
  return { tables, used }
}

/** Tables without any lines: runs of neighbouring rows that all split into the same aligned columns. */
function alignedTables(
  pieces: TextPiece[],
  pageWidth: number,
): { tables: DetectedTable[]; used: Set<TextPiece> } {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x0 - b.x0)
  const rows: Array<{ y: number; pieces: TextPiece[] }> = []
  for (const p of sorted) {
    const row = rows.at(-1)
    if (row && Math.abs(row.y - p.y) <= Math.max(2, p.size * 0.45)) row.pieces.push(p)
    else rows.push({ y: p.y, pieces: [p] })
  }
  const gaps = rows
    .slice(1)
    .map((r, i) => (rows[i] as (typeof rows)[number]).y - r.y)
    .sort((a, b) => a - b)
  const lineGap = gaps[Math.floor(gaps.length / 2)] ?? 12
  const tables: DetectedTable[] = []
  const used = new Set<TextPiece>()
  let run: typeof rows = []
  const flush = () => {
    if (run.length >= 3) {
      const table = alignTable(
        run.flatMap((r) => r.pieces),
        {
          gapEm: 1.8,
          minCols: 3,
          minRows: 3,
          fullShare: 0.6,
          minFullRows: 2,
          maxMedianLength: 40,
          maxCellWidth: pageWidth * 0.55,
          pageWidth,
        },
      )
      if (table) {
        tables.push(table)
        for (const r of run) for (const p of r.pieces) used.add(p)
      }
    }
    run = []
  }
  for (const row of rows) {
    const last = run.at(-1)
    const tabular = row.pieces.reduce((n, p) => n + splitPiece(p, 1.8).length, 0) >= 2
    if (!tabular || (last && last.y - row.y > lineGap * 2.5)) flush()
    if (tabular) run.push(row)
  }
  flush()
  return { tables, used }
}

/** Finds the tables of a page and returns the text pieces that are not part of any table. */
/** Regions of the tables drawn as grids on the page (used to skip the structure model there). */
export function gridRegions(pieces: TextPiece[], rulings: Rulings): Rect[] {
  return ruledTables(pieces, rulings).regions
}

/**
 * Text of the page distributed into the cells the structure model found. With `lineRows`, when
 * the region has exactly as many text lines as the model has rows, line k is row k and only the
 * model's columns are used (rows known from rules; the model's row boxes drift).
 */
export function tableFromModel(
  model: ModelTable,
  pieces: TextPiece[],
  options: { lineRows?: boolean } = {},
): { table: DetectedTable; used: Set<TextPiece>; stacked: number } | null {
  const texts = new Map<number, Array<{ x: number; y: number; line: number; text: string }>>()
  const used = new Set<TextPiece>()
  // Rows are bands of y (from the single-row cells); a piece joins the band its centre falls in,
  // then the cell of that row under its centre x. Cell boxes alone drift by a few points.
  const bands: Array<{ y0: number; y1: number }> = Array.from({ length: model.rows }, (_, r) => {
    const own = model.cells.filter((c) => c.row === r && c.rowSpan === 1)
    const any = own.length > 0 ? own : model.cells.filter((c) => c.row <= r && c.row + c.rowSpan > r)
    return {
      y0: Math.min(...any.map((c) => c.bbox.y0)),
      y1: Math.max(...any.map((c) => c.bbox.y1)),
    }
  })
  const rowAt = (cy: number) => {
    let best = -1
    let bestDist = Number.POSITIVE_INFINITY
    bands.forEach((b, r) => {
      const d = Math.max(b.y0 - cy, 0, cy - b.y1)
      if (d < bestDist) {
        bestDist = d
        best = r
      }
    })
    return bestDist <= 6 ? best : -1
  }
  const cellIn = (r: number, cx: number) => {
    let best = -1
    let bestScore = Number.POSITIVE_INFINITY
    model.cells.forEach((c, i) => {
      if (c.row > r || c.row + c.rowSpan <= r) return
      const outside = Math.max(c.bbox.x0 - cx, 0, cx - c.bbox.x1)
      if (outside > 8) return
      // Boxes of neighbouring cells overlap by a few points; the nearer centre decides.
      const score = outside * 1000 + Math.abs(cx - (c.bbox.x0 + c.bbox.x1) / 2)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    })
    return best
  }
  // Text lines of the region, top to bottom, each with the model row its centre falls in.
  const inRegion = pieces.filter((p) => {
    const cy = centerY(p)
    return cy >= model.region.y0 - TOL && cy <= model.region.y1 + TOL
  })
  const lines: Array<{ y: number; x0: number; size: number; row: number; pieces: TextPiece[] }> = []
  for (const p of inRegion.sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
    const last = lines[lines.length - 1]
    // Superscripts (footnote marks, units) sit up to half an em above their line.
    if (last && Math.abs(last.y - p.y) <= Math.max(1, Math.max(last.size, p.size) * 0.5)) {
      last.pieces.push(p)
      last.x0 = Math.min(last.x0, p.x0)
      if (p.size > last.size) {
        last.size = p.size
        last.y = p.y
      }
    } else lines.push({ y: p.y, x0: p.x0, size: p.size, row: -1, pieces: [p] })
  }
  for (const line of lines) line.row = rowAt(line.y + line.size * 0.35)
  const byLine = options.lineRows && lines.length === model.rows
  if (options.lineRows && process.env.RAG_CHUNKER_TABLE_DEBUG)
    console.error(`[table] model lines ${lines.length} rows ${model.rows}`)
  if (byLine) lines.forEach((line, i) => (line.row = i))
  // Cell boxes drift by a line at row boundaries of text-heavy cells. A line the model starts a
  // row with stays with the row above when it is spaced like that row's paragraph (tighter to the
  // line above than to the one below) and sits in the same column while the next line begins
  // further left, i.e. it is a wrapped line and the next one is the real first line of the row.
  for (let i = 1; i < lines.length - 1 && !byLine; i++) {
    const [above, line, below] = [lines[i - 1], lines[i], lines[i + 1]] as [
      (typeof lines)[number],
      (typeof lines)[number],
      (typeof lines)[number],
    ]
    if (line.row < 0 || above.row !== line.row - 1) continue
    const up = above.y - line.y
    const down = line.y - below.y
    if (up < 0.75 * down && Math.abs(line.x0 - above.x0) < line.size && line.x0 >= below.x0 + line.size)
      line.row = above.row
  }
  let parts = 0
  let straddling = 0
  lines.forEach((line, lineIndex) => {
    if (line.row < 0) return
    for (const p of line.pieces) {
      for (const part of splitPiece(p, 0.7)) {
        const cx = (part.x0 + part.x1) / 2
        if (cx < model.region.x0 - TOL || cx > model.region.x1 + TOL) continue
        const i = cellIn(line.row, cx)
        if (i < 0) continue
        const box = (model.cells[i] as ModelCell).bbox
        parts++
        // A part that runs well past its cell on either side is prose cut at a wide word gap,
        // not a cell: justified paragraphs inside a false "table" region look like this.
        if (Math.max(0, box.x0 - part.x0) + Math.max(0, part.x1 - box.x1) > p.size * 2) straddling++
        const list = texts.get(i) ?? []
        list.push({ x: part.x0, y: p.y, line: lineIndex, text: part.text })
        texts.set(i, list)
        used.add(p)
      }
    }
  })
  const filled = texts.size
  if (filled === 0 || model.cols < 2 || model.rows < 2 || filled < model.cells.length * 0.2) return null
  if (straddling > parts * 0.25) return null
  // Rows the model merged: cells holding short tokens from several text lines (numbers stacked
  // on top of each other). Wrapped prose and bullet lists in a cell are long and do not count.
  const stacked = [...texts.values()].filter(
    (list) => new Set(list.map((t) => t.line)).size >= 2 && list.every((t) => t.text.length <= 12),
  ).length
  if (stacked >= filled * 0.3) return null
  let cells: TableCell[] = model.cells.map((c, i) => {
    const list = (texts.get(i) ?? []).sort((a, b) => a.line - b.line || a.x - b.x)
    return {
      row: c.row,
      col: c.col,
      rowSpan: c.rowSpan,
      colSpan: c.colSpan,
      text: list
        .map((t) => t.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }
  })
  // Columns with no text at all are dropped (a list the layout model took for a table has one).
  const emptyCols = new Set(
    Array.from({ length: model.cols }, (_, c) => c).filter(
      (c) => !cells.some((cell) => cell.text !== '' && cell.col <= c && c < cell.col + cell.colSpan),
    ),
  )
  const cols = model.cols - emptyCols.size
  if (cols < 2) return null
  if (emptyCols.size > 0) {
    const kept = (c: number) => c - [...emptyCols].filter((e) => e < c).length
    cells = cells.flatMap((cell) => {
      const span = Array.from({ length: cell.colSpan }, (_, k) => cell.col + k).filter(
        (c) => !emptyCols.has(c),
      )
      const first = span[0]
      return first === undefined ? [] : [{ ...cell, col: kept(first), colSpan: span.length }]
    })
  }
  let headerRows = Math.max(1, model.headerRows)
  while (
    headerRows < model.rows - 1 &&
    headerRows < 3 &&
    cells.some((c) => c.row < headerRows && c.row + c.rowSpan > headerRows)
  )
    headerRows++
  const xs = [...used].flatMap((p) => [p.x0, p.x1])
  const bbox: Rect = {
    x0: Math.min(model.region.x0, ...xs),
    x1: Math.max(model.region.x1, ...xs),
    y0: Math.min(model.region.y0, ...[...used].map((p) => p.y - p.size * 0.25)),
    y1: Math.max(model.region.y1, ...[...used].map((p) => p.y + p.size * 0.8)),
  }
  return {
    table: { bbox, data: { rows: model.rows, cols, headerRows, cells, source: 'model' } },
    used,
    stacked,
  }
}

/** Share of `a` covered by `b`. */
function coverage(a: Rect, b: Rect): number {
  const inter = overlap(a.x0, a.x1, b.x0, b.x1) * overlap(a.y0, a.y1, b.y0, b.y1)
  const area = (a.x1 - a.x0) * (a.y1 - a.y0)
  return area > 0 ? inter / area : 0
}

/**
 * Finds the tables of a page and returns the text pieces that are not part of any table. With
 * `hints` (table regions from a layout model) line-less tables are only accepted inside a hint, and
 * a hint that no detector covered gets its columns from alignment with relaxed limits.
 */
export function detectTables<T extends TextPiece>(
  pieces: T[],
  rulings: Rulings,
  page: { width: number; hints?: Rect[]; models?: ModelTable[] },
): { tables: DetectedTable[]; remaining: T[] } {
  const ruled = ruledTables(pieces, rulings)
  let rest = pieces.filter((p) => !ruled.used.has(p))
  const bounded = ruleBoundedTables(rest, rulings, page.width, ruled.regions)
  rest = rest.filter((p) => !bounded.used.has(p))
  const aligned = alignedTables(rest, page.width)
  const found = [...ruled.tables, ...bounded.tables]
  if (page.hints) {
    const inHint = (t: DetectedTable) => (page.hints as Rect[]).some((h) => coverage(t.bbox, h) >= 0.5)
    aligned.tables = aligned.tables.filter(inHint)
    const candidates = rest
    const piecesOf = (t: DetectedTable) => candidates.filter((p) => inRect(p, t.bbox, TOL))
    aligned.used = new Set<TextPiece>(aligned.tables.flatMap(piecesOf))
    for (const hint of page.hints) {
      const model = page.models?.find(
        (m) => coverage(hint, m.region) >= 0.5 || coverage(m.region, hint) >= 0.5,
      )
      // Lines and rules are exact evidence and win. Between horizontal rules the columns come
      // from alignment, though, and when the model agrees on the rows but separates columns that
      // alignment merged (narrow numeric columns), its cells replace them.
      const exact = found.findIndex((t) => coverage(hint, t.bbox) >= 0.5)
      if (exact >= 0) {
        const current = found[exact] as DetectedTable
        if (
          model &&
          current.data.source === 'rules' &&
          model.rows === current.data.rows &&
          model.cols > current.data.cols
        ) {
          const own = pieces.filter((p) => bounded.used.has(p) && inRect(p, current.bbox, TOL))
          const built = tableFromModel(model, own, { lineRows: true })
          if (built && built.stacked === 0 && built.used.size >= own.length) found[exact] = built.table
          if (process.env.RAG_CHUNKER_TABLE_DEBUG)
            console.error(
              `[table] model refine own ${own.length} used ${built?.used.size ?? 'null'} stacked ${built?.stacked ?? '-'} bbox ${JSON.stringify(current.bbox)}`,
            )
        }
        continue
      }
      // Between aligned columns and the structure model, whichever places more of the region's
      // text wins; a tie keeps the alignment (one piece per cell, no drift from the model boxes).
      // Spanning headers are the usual case where the model explains text that alignment left out.
      const alignedHere = aligned.tables.filter((t) => coverage(t.bbox, hint) >= 0.5)
      const alignedUsed = new Set<TextPiece>(alignedHere.flatMap(piecesOf))
      const built = model
        ? tableFromModel(
            model,
            candidates.filter((p) => !aligned.used.has(p) || alignedUsed.has(p)),
          )
        : null
      if (built && built.used.size > alignedUsed.size) {
        aligned.tables = aligned.tables.filter((t) => !alignedHere.includes(t))
        for (const p of alignedUsed) aligned.used.delete(p)
        for (const p of built.used) aligned.used.add(p)
        aligned.tables.push(built.table)
        continue
      }
      if (alignedHere.some((t) => coverage(hint, t.bbox) >= 0.5)) continue
      // Nothing explains the region yet: alignment with relaxed limits.
      const inside = candidates.filter((p) => !aligned.used.has(p) && inRect(p, hint, 4))
      if (inside.length < 2) continue
      const table = alignTable(inside, {
        gapEm: 0.7,
        minCols: 2,
        minRows: 2,
        fullShare: 0.4,
        minFullRows: 1,
        maxMedianLength: 80,
        maxCellWidth: (hint.x1 - hint.x0) * 0.9,
        pageWidth: page.width,
      })
      if (!table) continue
      aligned.tables.push(table)
      for (const p of inside) aligned.used.add(p)
    }
  }
  rest = rest.filter((p) => !aligned.used.has(p))
  const tables = [...found, ...aligned.tables]
    .filter((t) => t.data.cells.some((c) => c.text !== ''))
    .sort((a, b) => b.bbox.y1 - a.bbox.y1)
  return { tables, remaining: rest }
}

function grid(t: TableData): string[][] {
  const g: string[][] = Array.from({ length: t.rows }, () => new Array<string>(t.cols).fill(''))
  for (const c of t.cells) {
    const row = g[c.row]
    if (row) row[c.col] = c.text
  }
  return g
}

const mdCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** GFM table: header rows are merged into the single header line GFM allows; spans leave blanks. */
export function tableToMarkdown(t: TableData): string {
  if (t.rows === 0 || t.cols === 0) return ''
  const g = grid(t)
  const headerRows = Math.max(1, Math.min(t.headerRows, t.rows))
  const header = Array.from({ length: t.cols }, (_, c) =>
    g
      .slice(0, headerRows)
      .map((r) => r[c] ?? '')
      .filter((s) => s !== '')
      .join(' '),
  )
  const line = (cells: string[]) => `| ${cells.map(mdCell).join(' | ')} |`
  const out = [line(header), `|${' --- |'.repeat(t.cols)}`]
  for (const row of g.slice(headerRows)) out.push(line(row))
  return out.join('\n')
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** HTML table with colspan/rowspan, for consumers that need the merged cells. */
export function tableToHtml(t: TableData): string {
  const byPos = new Map(t.cells.map((c) => [`${c.row}:${c.col}`, c]))
  const covered = new Set<string>()
  for (const c of t.cells) {
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let cc = c.col; cc < c.col + c.colSpan; cc++)
        if (r !== c.row || cc !== c.col) covered.add(`${r}:${cc}`)
  }
  const rowHtml = (r: number, tag: 'th' | 'td') => {
    const parts: string[] = []
    for (let c = 0; c < t.cols; c++) {
      const key = `${r}:${c}`
      if (covered.has(key)) continue
      const cell = byPos.get(key)
      const attrs = `${cell && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}`
      parts.push(`<${tag}${attrs}>${escapeHtml(cell?.text ?? '')}</${tag}>`)
    }
    return `<tr>${parts.join('')}</tr>`
  }
  const headerRows = Math.min(t.headerRows, t.rows)
  const head =
    headerRows > 0
      ? `<thead>${Array.from({ length: headerRows }, (_, r) => rowHtml(r, 'th')).join('')}</thead>`
      : ''
  const body = `<tbody>${Array.from({ length: t.rows - headerRows }, (_, i) => rowHtml(i + headerRows, 'td')).join('')}</tbody>`
  return `<table>${head}${body}</table>`
}

/** The header rows' texts per column, for comparing tables across pages. */
export function headerTexts(t: TableData): string[] {
  const g = grid(t)
  return Array.from({ length: t.cols }, (_, c) =>
    g
      .slice(0, Math.max(1, t.headerRows))
      .map((r) => r[c] ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  )
}

/** `next` with the header rows of `prev` prepended (a table continuing on the next page). */
export function withHeaderOf(prev: TableData, next: TableData): TableData {
  const h = Math.max(1, prev.headerRows)
  return {
    rows: next.rows + h,
    cols: next.cols,
    headerRows: h,
    cells: [
      ...prev.cells.filter((c) => c.row < h).map((c) => ({ ...c, rowSpan: Math.min(c.rowSpan, h - c.row) })),
      ...next.cells.map((c) => ({ ...c, row: c.row + h })),
    ],
    source: next.source,
    continuation: true,
  }
}
