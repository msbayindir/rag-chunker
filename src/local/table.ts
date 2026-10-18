import type { CacheStore } from '../cache/store.js'
import type { Rect } from '../documents/tables.js'
import { importOptional } from '../util/optional.js'
import type { PageLike } from './layout.js'
import { ensureModel, type ModelId } from './models.js'
import { sessionFor } from './runtime.js'

/**
 * Table structure recognition with SLANet_plus (PP-StructureV2): from the image of a table it
 * predicts the HTML structure (rows, cells, colspan/rowspan) and a box per cell. Text is then
 * matched into the cells from the text layer or OCR, so the model never has to read characters.
 */

export const TABLE_MODEL: ModelId = 'slanet-plus'
export const TABLE_DICT: ModelId = 'slanet-dict'

const INPUT = 488
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
/** Padding (page points) added around the region before cropping, so border cells are not cut. */
const CROP_PAD = 4

/** A cell of a model-recognised table; the box is in page points (y up) once mapped. */
export interface ModelCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  bbox: Rect
}

export interface ModelTable {
  rows: number
  cols: number
  headerRows: number
  cells: ModelCell[]
  /** The region the table was recognised in (page points). */
  region: Rect
}

/**
 * The structure vocabulary as SLANet decodes it: PaddleOCR's `merge_no_span_structure` drops the
 * bare `<td>` token and appends `<td></td>`; `sos` and `eos` frame the list.
 */
export function structureVocabulary(dictionary: string): string[] {
  const lines = dictionary
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l !== '' && l !== '<td>')
  return ['sos', ...lines, '<td></td>', 'eos']
}

/** Greedy decode of the structure head: tokens until `eos`, with the step index of every cell token. */
export function decodeStructure(
  probs: ArrayLike<number>,
  steps: number,
  classes: number,
  vocabulary: readonly string[],
): { tokens: string[]; cellSteps: number[] } {
  const tokens: string[] = []
  const cellSteps: number[] = []
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestValue = Number.NEGATIVE_INFINITY
    for (let c = 0; c < classes; c++) {
      const v = probs[t * classes + c] as number
      if (v > bestValue) {
        bestValue = v
        best = c
      }
    }
    const token = vocabulary[best] ?? ''
    if (token === 'eos') break
    if (token === 'sos') continue
    if (token === '<td></td>' || token === '<td') cellSteps.push(t)
    tokens.push(token)
  }
  return { tokens, cellSteps }
}

/**
 * Turns the HTML token stream into a grid: the standard table layout algorithm, where a cell takes
 * the first free column of its row and spans block the columns of the rows below.
 */
export function structureToGrid(tokens: readonly string[]): {
  rows: number
  cols: number
  headerRows: number
  cells: Array<Omit<ModelCell, 'bbox'>>
} {
  const cells: Array<Omit<ModelCell, 'bbox'>> = []
  const occupied = new Set<string>()
  let row = -1
  let col = 0
  let headerRows = 0
  let inHead = false
  let open: { colSpan: number; rowSpan: number } | null = null
  const place = (colSpan: number, rowSpan: number) => {
    if (row < 0) row = 0
    while (occupied.has(`${row}:${col}`)) col++
    for (let r = row; r < row + rowSpan; r++)
      for (let c = col; c < col + colSpan; c++) occupied.add(`${r}:${c}`)
    cells.push({ row, col, rowSpan, colSpan })
    col += colSpan
  }
  for (const token of tokens) {
    if (token === '<thead>') inHead = true
    else if (token === '</thead>') inHead = false
    else if (token === '<tr>') {
      row++
      col = 0
      if (inHead) headerRows = row + 1
    } else if (token === '<td></td>') place(1, 1)
    else if (token === '<td') open = { colSpan: 1, rowSpan: 1 }
    else if (open && token.startsWith(' colspan="')) open.colSpan = Number(token.slice(10, -1)) || 1
    else if (open && token.startsWith(' rowspan="')) open.rowSpan = Number(token.slice(10, -1)) || 1
    else if (token === '>' && open) {
      place(open.colSpan, open.rowSpan)
      open = null
    }
  }
  const rows = cells.reduce((m, c) => Math.max(m, c.row + c.rowSpan), 0)
  const cols = cells.reduce((m, c) => Math.max(m, c.col + c.colSpan), 0)
  return { rows, cols, headerRows: Math.min(headerRows, rows), cells }
}

export interface TableModelPaths {
  model: string
  vocabulary: string[]
}

/**
 * Recognises the structure of the table inside `region` of a page image. `image` is the rendered
 * page, `imageRect` the region in that image's pixels; cell boxes come back in page points.
 */
export async function recognizeTableStructure(
  image: Uint8Array,
  imageRect: Rect,
  toPagePoints: (x: number, y: number) => [number, number],
  models: TableModelPaths,
): Promise<ModelTable | null> {
  const canvasMod = await importOptional(
    '@napi-rs/canvas',
    'Table structure recognition',
    () => import('@napi-rs/canvas'),
  )
  const rt = await import('onnxruntime-node')
  const [session, img] = await Promise.all([
    sessionFor(models.model, 'Table structure recognition'),
    canvasMod.loadImage(Buffer.from(image)),
  ])
  const cx0 = Math.max(0, imageRect.x0)
  const cy0 = Math.max(0, imageRect.y0)
  const cw = Math.min(img.width, imageRect.x1) - cx0
  const ch = Math.min(img.height, imageRect.y1) - cy0
  if (cw < 8 || ch < 8) return null
  // Longest side to 488, padded with black to a square (what the model was trained with).
  const ratio = INPUT / Math.max(cw, ch)
  const rw = Math.max(1, Math.round(cw * ratio))
  const rh = Math.max(1, Math.round(ch * ratio))
  const canvas = canvasMod.createCanvas(INPUT, INPUT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, INPUT, INPUT)
  ctx.drawImage(img, cx0, cy0, cw, ch, 0, 0, rw, rh)
  const { data } = ctx.getImageData(0, 0, INPUT, INPUT)
  const plane = INPUT * INPUT
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const r = (data[i * 4] as number) / 255
    const g = (data[i * 4 + 1] as number) / 255
    const b = (data[i * 4 + 2] as number) / 255
    input[i] = (b - (MEAN[0] as number)) / (STD[0] as number)
    input[plane + i] = (g - (MEAN[1] as number)) / (STD[1] as number)
    input[2 * plane + i] = (r - (MEAN[2] as number)) / (STD[2] as number)
  }
  const out = await session.run({
    [session.inputNames[0] as string]: new rt.Tensor('float32', input, [1, 3, INPUT, INPUT]),
  })
  const tensors = session.outputNames.map((n) => out[n]).filter((t): t is NonNullable<typeof t> => !!t)
  const probs = tensors.find((t) => t.dims[2] === models.vocabulary.length)
  const loc = tensors.find((t) => t !== probs)
  if (!probs || !loc) return null
  const [, steps = 0, classes = 0] = probs.dims
  const locWidth = loc.dims[2] ?? 8
  const { tokens, cellSteps } = decodeStructure(
    probs.data as ArrayLike<number>,
    steps,
    classes,
    models.vocabulary,
  )
  const grid = structureToGrid(tokens)
  if (grid.cells.length === 0 || grid.cells.length !== cellSteps.length) return null
  const cells: ModelCell[] = grid.cells.map((cell, i) => {
    const step = cellSteps[i] as number
    const locData = loc.data as ArrayLike<number>
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < locWidth; k++) (k % 2 === 0 ? xs : ys).push(locData[step * locWidth + k] as number)
    // Boxes are normalised to the padded square; back to crop pixels, then page points.
    const px0 = cx0 + (Math.min(...xs) * INPUT) / ratio
    const px1 = cx0 + (Math.max(...xs) * INPUT) / ratio
    const pyTop = cy0 + (Math.min(...ys) * INPUT) / ratio
    const pyBottom = cy0 + (Math.max(...ys) * INPUT) / ratio
    const [x0, y1] = toPagePoints(px0, pyTop)
    const [x1, y0] = toPagePoints(px1, pyBottom)
    return { ...cell, bbox: { x0, x1, y0, y1 } }
  })
  const [rx0, ry1] = toPagePoints(cx0, cy0)
  const [rx1, ry0] = toPagePoints(cx0 + cw, cy0 + ch)
  return {
    rows: grid.rows,
    cols: grid.cols,
    headerRows: grid.headerRows,
    cells,
    region: { x0: rx0, x1: rx1, y0: ry0, y1: ry1 },
  }
}

/** What the PDF reader calls for each table region (page points) of a page. */
export type TableStructureProvider = (
  doc: PageLike,
  pageNumber: number,
  region: Rect,
) => Promise<ModelTable | null>

export interface TableProviderOptions {
  /** Longer page side in pixels rendered for the crops (default 2000). */
  render?: number
  cache?: CacheStore
  documentId?: string
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
}

const TABLE_CACHE_VERSION = 1

/** Downloads SLANet_plus on first use (8 MB) and recognises table regions, caching per document region. */
export async function createTableStructureProvider(
  options: TableProviderOptions = {},
): Promise<TableStructureProvider> {
  const { readFile } = await import('node:fs/promises')
  const fetchOne = (id: ModelId) =>
    ensureModel(id, {
      dir: options.modelsDir,
      signal: options.signal,
      onProgress: (done, total) => options.onModelDownload?.(id, done, total),
    })
  const [model, dictPath] = await Promise.all([fetchOne(TABLE_MODEL), fetchOne(TABLE_DICT)])
  const models: TableModelPaths = { model, vocabulary: structureVocabulary(await readFile(dictPath, 'utf8')) }
  const render = options.render ?? 2000
  const renders = new Map<string, Promise<{ png: Uint8Array; width: number; height: number }>>()
  return async (doc, pageNumber, region) => {
    const key = options.cache?.key(
      'table-model',
      TABLE_CACHE_VERSION,
      TABLE_MODEL,
      options.documentId ?? '',
      pageNumber,
      render,
      region,
    )
    if (key && options.cache) {
      const hit = await options.cache.get<ModelTable | null>('table-model', key)
      if (hit !== undefined) return hit
    }
    const renderKey = `${options.documentId ?? ''}:${pageNumber}`
    let page = renders.get(renderKey)
    if (!page) {
      page = Promise.all([doc.renderPng(pageNumber, render), doc.pageSize(pageNumber)]).then(
        ([png, size]) => ({ png, ...size }),
      )
      renders.set(renderKey, page)
      // One render per page is kept only while its tables are being recognised.
      page.finally(() => setTimeout(() => renders.delete(renderKey), 0))
    }
    const { png, width, height } = await page
    const canvasMod = await importOptional(
      '@napi-rs/canvas',
      'Table structure recognition',
      () => import('@napi-rs/canvas'),
    )
    const img = await canvasMod.loadImage(Buffer.from(png))
    const sx = img.width / width
    const sy = img.height / height
    const imageRect: Rect = {
      x0: (region.x0 - CROP_PAD) * sx,
      x1: (region.x1 + CROP_PAD) * sx,
      y0: (height - region.y1 - CROP_PAD) * sy,
      y1: (height - region.y0 + CROP_PAD) * sy,
    }
    const result = await recognizeTableStructure(png, imageRect, (x, y) => [x / sx, height - y / sy], models)
    if (key && options.cache) await options.cache.set('table-model', key, result)
    return result
  }
}
