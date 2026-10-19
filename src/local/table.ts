import type { CacheStore } from '../cache/store.js'
import type { Rect } from '../documents/tables.js'
import { importOptional } from '../util/optional.js'
import type { PageLike } from './layout.js'
import { ensureModel, type ModelId } from './models.js'
import { sessionFor } from './runtime.js'

/**
 * Table structure recognition with the SLANet family (PP-StructureV2/V3): from the image of a table
 * a model predicts the HTML structure (rows, cells, colspan/rowspan) and a box per cell. Text is
 * then matched into the cells from the text layer or OCR, so the model never has to read characters.
 * SLANet_plus is one small model for every table; SLANeXt comes as two larger models, one for ruled
 * (wired) and one for borderless (wireless) tables, with a classifier that tells them apart.
 */

/** The small structure model (the `basic` profile) and the dictionary every SLANet model shares. */
export const TABLE_MODEL: ModelId = 'slanet-plus'
export const TABLE_DICT: ModelId = 'slanet-dict'
export const TABLE_CLASSIFIER: ModelId = 'table-cls'

/**
 * Structure models with the square input they were trained on (longest side, padded with black) and
 * what their cell boxes are normalised to: SLANet_plus to the padded square, SLANeXt to the table
 * image itself (its y coordinates would otherwise stretch by the table's aspect ratio).
 */
export const STRUCTURE_MODELS = {
  'slanet-plus': { model: 'slanet-plus', input: 488, boxes: 'padded' },
  'slanext-wired': { model: 'slanext-wired', input: 512, boxes: 'image' },
  'slanext-wireless': { model: 'slanext-wireless', input: 512, boxes: 'image' },
} as const satisfies Record<string, { model: ModelId; input: number; boxes: 'padded' | 'image' }>

export type StructureModel = keyof typeof STRUCTURE_MODELS
export type TableModelChoice = 'slanet-plus' | 'slanext'

/** Which structure model reads ruled and borderless tables, and whether a classifier decides. */
export interface TablePlan {
  wired: StructureModel
  wireless: StructureModel
  classify: boolean
}

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
/** Padding (page points) added around the region before cropping, so border cells are not cut. */
const CROP_PAD = 4
/** Classifier input: short side resized to 256, centre crop of 224 (PP-LCNet as PaddleX runs it). */
const CLS_SHORT = 256
const CLS_CROP = 224

/**
 * The table models a configuration asks for: an explicit `layout.tables` wins, then the
 * RAG_CHUNKER_TABLE_MODEL environment override, then the profile ("full": SLANeXt, "basic":
 * SLANet_plus). RAG_CHUNKER_TABLE_WIRELESS picks the model for borderless tables under SLANeXt.
 */
export function resolveTablePlan(
  config: { layout: { tables: 'auto' | TableModelChoice }; local: { profile: 'full' | 'basic' } },
  env: Record<string, string | undefined> = process.env,
): TablePlan {
  const fromEnv = env.RAG_CHUNKER_TABLE_MODEL
  const choice: TableModelChoice =
    config.layout.tables !== 'auto'
      ? config.layout.tables
      : fromEnv === 'slanet-plus' || fromEnv === 'slanext'
        ? fromEnv
        : config.local.profile === 'basic'
          ? 'slanet-plus'
          : 'slanext'
  if (choice === 'slanet-plus') return { wired: 'slanet-plus', wireless: 'slanet-plus', classify: false }
  const wireless = env.RAG_CHUNKER_TABLE_WIRELESS === 'slanet-plus' ? 'slanet-plus' : 'slanext-wireless'
  return { wired: 'slanext-wired', wireless, classify: true }
}

/** Every model file a plan needs (structure models, dictionary, classifier). */
export function tablePlanModels(plan: TablePlan): ModelId[] {
  const ids = new Set<ModelId>([
    STRUCTURE_MODELS[plan.wired].model,
    STRUCTURE_MODELS[plan.wireless].model,
    TABLE_DICT,
  ])
  if (plan.classify) ids.add(TABLE_CLASSIFIER)
  return [...ids]
}

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
  /** The structure model that read it, and what the classifier called the table (when one ran). */
  model?: StructureModel
  kind?: 'wired' | 'wireless'
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
  /** Square input side of the model (default 488, SLANet_plus). */
  input?: number
  /** What the cell boxes are normalised to (default "padded", SLANet_plus). */
  boxes?: 'padded' | 'image'
}

type CanvasModule = typeof import('@napi-rs/canvas')
type LoadedImage = Awaited<ReturnType<CanvasModule['loadImage']>>

const loadCanvas = () =>
  importOptional('@napi-rs/canvas', 'Table structure recognition', () => import('@napi-rs/canvas'))

/** The crop of `imageRect` inside the image, or null when it is too small to read. */
function cropOf(img: LoadedImage, imageRect: Rect) {
  const x0 = Math.max(0, imageRect.x0)
  const y0 = Math.max(0, imageRect.y0)
  const w = Math.min(img.width, imageRect.x1) - x0
  const h = Math.min(img.height, imageRect.y1) - y0
  return w < 8 || h < 8 ? null : { x0, y0, w, h }
}

/**
 * Ruled or borderless: PP-LCNet_x1_0_table_cls on the crop (RGB, short side 256, centre 224).
 * Returns the label and its probability.
 */
async function classifyTable(
  canvasMod: CanvasModule,
  img: LoadedImage,
  crop: { x0: number; y0: number; w: number; h: number },
  modelPath: string,
): Promise<{ kind: 'wired' | 'wireless'; score: number }> {
  const rt = await import('onnxruntime-node')
  const session = await sessionFor(modelPath, 'Table classification')
  const scale = CLS_SHORT / Math.min(crop.w, crop.h)
  const side = CLS_CROP / scale
  const canvas = canvasMod.createCanvas(CLS_CROP, CLS_CROP)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(
    img,
    crop.x0 + (crop.w - side) / 2,
    crop.y0 + (crop.h - side) / 2,
    side,
    side,
    0,
    0,
    CLS_CROP,
    CLS_CROP,
  )
  const { data } = ctx.getImageData(0, 0, CLS_CROP, CLS_CROP)
  const plane = CLS_CROP * CLS_CROP
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * plane + i] = ((data[i * 4 + c] as number) / 255 - (MEAN[c] as number)) / (STD[c] as number)
    }
  }
  const out = await session.run({
    [session.inputNames[0] as string]: new rt.Tensor('float32', input, [1, 3, CLS_CROP, CLS_CROP]),
  })
  const probs = out[session.outputNames[0] as string]?.data as ArrayLike<number> | undefined
  const wired = Number(probs?.[0] ?? 1)
  const wireless = Number(probs?.[1] ?? 0)
  return wired >= wireless ? { kind: 'wired', score: wired } : { kind: 'wireless', score: wireless }
}

/**
 * A cell box from the model's normalised polygon to image pixels (y down). SLANet_plus normalises to
 * the padded square the crop was drawn into (side = the crop's longest side), SLANeXt to the crop.
 */
export function cellBoxPixels(
  xs: readonly number[],
  ys: readonly number[],
  crop: { x0: number; y0: number; w: number; h: number },
  boxes: 'padded' | 'image',
): { x0: number; y0: number; x1: number; y1: number } {
  const square = Math.max(crop.w, crop.h)
  const sw = boxes === 'image' ? crop.w : square
  const sh = boxes === 'image' ? crop.h : square
  return {
    x0: crop.x0 + Math.min(...xs) * sw,
    x1: crop.x0 + Math.max(...xs) * sw,
    y0: crop.y0 + Math.min(...ys) * sh,
    y1: crop.y0 + Math.max(...ys) * sh,
  }
}

type PixelBox = { x0: number; y0: number; x1: number; y1: number }

/**
 * Cell areas from content boxes: SLANeXt boxes hug the text of a cell, while the text matching
 * expects the cell's whole area (as SLANet_plus predicts it). Every column gets the span between
 * the midpoints to its neighbours (from its single-column cells), every row likewise, and a cell
 * covers the columns and rows it spans. Returns the boxes unchanged when a row or column has no
 * single-span cell to measure.
 */
export function cellAreas(
  cells: ReadonlyArray<{ row: number; col: number; rowSpan: number; colSpan: number }>,
  boxes: readonly PixelBox[],
  rows: number,
  cols: number,
  crop: { x0: number; y0: number; w: number; h: number },
): PixelBox[] {
  const extent = (
    n: number,
    key: 'col' | 'row',
    span: 'colSpan' | 'rowSpan',
    lo: 'x0' | 'y0',
    hi: 'x1' | 'y1',
  ) =>
    Array.from({ length: n }, (_, k) => {
      const own = cells.flatMap((c, i) => (c[key] === k && c[span] === 1 ? [boxes[i] as PixelBox] : []))
      return own.length === 0
        ? null
        : { lo: Math.min(...own.map((b) => b[lo])), hi: Math.max(...own.map((b) => b[hi])) }
    })
  const colExt = extent(cols, 'col', 'colSpan', 'x0', 'x1')
  const rowExt = extent(rows, 'row', 'rowSpan', 'y0', 'y1')
  if (colExt.some((e) => e === null) || rowExt.some((e) => e === null)) return [...boxes]
  const edges = (ext: Array<{ lo: number; hi: number } | null>, start: number, end: number) => {
    const e = ext as Array<{ lo: number; hi: number }>
    const cuts = [start]
    for (let k = 1; k < e.length; k++)
      cuts.push(((e[k - 1] as { hi: number }).hi + (e[k] as { lo: number }).lo) / 2)
    cuts.push(end)
    return cuts
  }
  const xc = edges(colExt, crop.x0, crop.x0 + crop.w)
  const yc = edges(rowExt, crop.y0, crop.y0 + crop.h)
  return cells.map((c) => ({
    x0: xc[c.col] as number,
    x1: xc[c.col + c.colSpan] as number,
    y0: yc[c.row] as number,
    y1: yc[c.row + c.rowSpan] as number,
  }))
}

/** Runs a structure model on the crop of a loaded image; cell boxes come back in page points. */
async function readStructure(
  canvasMod: CanvasModule,
  img: LoadedImage,
  crop: { x0: number; y0: number; w: number; h: number },
  toPagePoints: (x: number, y: number) => [number, number],
  models: TableModelPaths,
): Promise<ModelTable | null> {
  const rt = await import('onnxruntime-node')
  const session = await sessionFor(models.model, 'Table structure recognition')
  const size = models.input ?? STRUCTURE_MODELS['slanet-plus'].input
  const { x0: cx0, y0: cy0, w: cw, h: ch } = crop
  // Longest side to the model's input, padded with black to a square (what the model was trained with).
  const ratio = size / Math.max(cw, ch)
  const rw = Math.max(1, Math.round(cw * ratio))
  const rh = Math.max(1, Math.round(ch * ratio))
  const canvas = canvasMod.createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(img, cx0, cy0, cw, ch, 0, 0, rw, rh)
  const { data } = ctx.getImageData(0, 0, size, size)
  const plane = size * size
  const input = new Float32Array(3 * plane)
  // BGR planes: the SLANet models were trained on OpenCV images.
  for (let i = 0; i < plane; i++) {
    const r = (data[i * 4] as number) / 255
    const g = (data[i * 4 + 1] as number) / 255
    const b = (data[i * 4 + 2] as number) / 255
    input[i] = (b - (MEAN[0] as number)) / (STD[0] as number)
    input[plane + i] = (g - (MEAN[1] as number)) / (STD[1] as number)
    input[2 * plane + i] = (r - (MEAN[2] as number)) / (STD[2] as number)
  }
  const out = await session.run({
    [session.inputNames[0] as string]: new rt.Tensor('float32', input, [1, 3, size, size]),
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
  const locData = loc.data as ArrayLike<number>
  const pixelBoxes = grid.cells.map((_cell, i) => {
    const step = cellSteps[i] as number
    const xs: number[] = []
    const ys: number[] = []
    for (let k = 0; k < locWidth; k++) (k % 2 === 0 ? xs : ys).push(locData[step * locWidth + k] as number)
    return cellBoxPixels(xs, ys, crop, models.boxes ?? 'padded')
  })
  const areas =
    models.boxes === 'image' ? cellAreas(grid.cells, pixelBoxes, grid.rows, grid.cols, crop) : pixelBoxes
  const cells: ModelCell[] = grid.cells.map((cell, i) => {
    const px = areas[i] as PixelBox
    const [x0, y1] = toPagePoints(px.x0, px.y0)
    const [x1, y0] = toPagePoints(px.x1, px.y1)
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
  const canvasMod = await loadCanvas()
  const img = await canvasMod.loadImage(Buffer.from(image))
  const crop = cropOf(img, imageRect)
  return crop ? readStructure(canvasMod, img, crop, toPagePoints, models) : null
}

/** What the PDF reader calls for each table region (page points) of a page. */
export type TableStructureProvider = (
  doc: PageLike,
  pageNumber: number,
  region: Rect,
) => Promise<ModelTable | null>

export interface TableProviderOptions {
  /** Which models read which tables (default: SLANet_plus for all, see resolveTablePlan). */
  plan?: TablePlan
  /** Longer page side in pixels rendered for the crops (default 2000). */
  render?: number
  cache?: CacheStore
  documentId?: string
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
}

const TABLE_CACHE_VERSION = 3

/**
 * Downloads the plan's table models on first use (SLANet_plus 8 MB; SLANeXt 365 MB per model plus
 * the 7 MB classifier) and recognises table regions, caching per document region.
 */
export async function createTableStructureProvider(
  options: TableProviderOptions = {},
): Promise<TableStructureProvider> {
  const { readFile } = await import('node:fs/promises')
  const plan: TablePlan = options.plan ?? { wired: 'slanet-plus', wireless: 'slanet-plus', classify: false }
  const fetchOne = (id: ModelId) =>
    ensureModel(id, {
      dir: options.modelsDir,
      signal: options.signal,
      onProgress: (done, total) => options.onModelDownload?.(id, done, total),
    })
  const ids = tablePlanModels(plan)
  const paths = new Map(await Promise.all(ids.map(async (id) => [id, await fetchOne(id)] as const)))
  const vocabulary = structureVocabulary(await readFile(paths.get(TABLE_DICT) as string, 'utf8'))
  const modelFor = (which: StructureModel): TableModelPaths => ({
    model: paths.get(STRUCTURE_MODELS[which].model) as string,
    vocabulary,
    input: STRUCTURE_MODELS[which].input,
    boxes: STRUCTURE_MODELS[which].boxes,
  })
  const planTag = plan.classify ? `${plan.wired}+${plan.wireless}` : plan.wired
  const render = options.render ?? 2000
  const renders = new Map<string, Promise<{ png: Uint8Array; width: number; height: number }>>()
  return async (doc, pageNumber, region) => {
    const key = options.cache?.key(
      'table-model',
      TABLE_CACHE_VERSION,
      planTag === 'slanet-plus' ? TABLE_MODEL : planTag,
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
    const canvasMod = await loadCanvas()
    const img = await canvasMod.loadImage(Buffer.from(png))
    const sx = img.width / width
    const sy = img.height / height
    const crop = cropOf(img, {
      x0: (region.x0 - CROP_PAD) * sx,
      x1: (region.x1 + CROP_PAD) * sx,
      y0: (height - region.y1 - CROP_PAD) * sy,
      y1: (height - region.y0 + CROP_PAD) * sy,
    })
    let result: ModelTable | null = null
    if (crop) {
      const kind = plan.classify
        ? (await classifyTable(canvasMod, img, crop, paths.get(TABLE_CLASSIFIER) as string)).kind
        : undefined
      const which = kind === 'wireless' ? plan.wireless : plan.wired
      const table = await readStructure(
        canvasMod,
        img,
        crop,
        (x, y) => [x / sx, height - y / sy],
        modelFor(which),
      )
      result = table ? { ...table, model: which, ...(kind ? { kind } : {}) } : null
    }
    if (key && options.cache) await options.cache.set('table-model', key, result)
    return result
  }
}
