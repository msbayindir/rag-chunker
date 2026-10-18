import type { CacheStore } from '../cache/store.js'
import type { Rect } from '../documents/tables.js'
import { importOptional } from '../util/optional.js'
import { ensureModel, type ModelId } from './models.js'
import { sessionFor } from './runtime.js'

/**
 * Page layout analysis with PP-DocLayoutV3 (RT-DETR based, 25 classes, reading order). The model
 * takes an 800×800 RGB image and returns boxes in the coordinates of the image it was given.
 */

/** Class names in the model's index order. */
export const LAYOUT_LABELS = [
  'abstract',
  'algorithm',
  'aside_text',
  'chart',
  'content',
  'display_formula',
  'doc_title',
  'figure_title',
  'footer',
  'footer_image',
  'footnote',
  'formula_number',
  'header',
  'header_image',
  'image',
  'inline_formula',
  'number',
  'paragraph_title',
  'reference',
  'reference_content',
  'seal',
  'table',
  'text',
  'vertical_text',
  'vision_footnote',
] as const

export type LayoutLabel = (typeof LAYOUT_LABELS)[number]

export interface LayoutRegion {
  label: LayoutLabel
  score: number
  /** Position in PDF points (y up), like the text layer. */
  bbox: Rect
  /** Reading-order rank from the model (lower comes first). */
  order: number
}

export const LAYOUT_MODEL: ModelId = 'pp-doclayout-v3'
const INPUT_SIZE = 800

/** Raw rows of the model's first output: [class, score, x1, y1, x2, y2, order] in image pixels. */
export interface RawDetection {
  cls: number
  score: number
  x1: number
  y1: number
  x2: number
  y2: number
  order: number
}

export function parseDetections(data: ArrayLike<number>, dims: readonly number[]): RawDetection[] {
  const [n = 0, cols = 7] = dims
  const out: RawDetection[] = []
  for (let i = 0; i < n; i++) {
    const r = i * cols
    out.push({
      cls: data[r] as number,
      score: data[r + 1] as number,
      x1: data[r + 2] as number,
      y1: data[r + 3] as number,
      x2: data[r + 4] as number,
      y2: data[r + 5] as number,
      order: cols > 6 ? (data[r + 6] as number) : i,
    })
  }
  return out
}

const area = (d: RawDetection) => Math.max(0, d.x2 - d.x1) * Math.max(0, d.y2 - d.y1)
function intersection(a: RawDetection, b: RawDetection): number {
  return (
    Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
    Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  )
}

/**
 * Keeps confident detections, drops a box that is (almost) contained in a bigger box of the same
 * class and the weaker of two boxes that overlap heavily, then orders by the model's reading order.
 */
export function selectDetections(all: RawDetection[], minScore: number): RawDetection[] {
  const kept = all.filter((d) => d.score >= minScore && area(d) > 0).sort((a, b) => b.score - a.score)
  const out: RawDetection[] = []
  for (const d of kept) {
    const redundant = out.some((o) => {
      const inter = intersection(o, d)
      const ioMin = inter / Math.min(area(o), area(d))
      const iou = inter / (area(o) + area(d) - inter)
      return (o.cls === d.cls && ioMin > 0.8) || iou > 0.8
    })
    if (!redundant) out.push(d)
  }
  return out.sort((a, b) => a.order - b.order)
}

/** Maps detections from image pixels to PDF points (origin bottom-left). */
export function toRegions(
  detections: RawDetection[],
  image: { width: number; height: number },
  page: { width: number; height: number },
): LayoutRegion[] {
  const sx = page.width / image.width
  const sy = page.height / image.height
  return detections.map((d) => ({
    label: LAYOUT_LABELS[Math.round(d.cls)] ?? 'text',
    score: d.score,
    order: d.order,
    bbox: {
      x0: Math.max(0, d.x1 * sx),
      x1: Math.min(page.width, d.x2 * sx),
      y0: Math.max(0, page.height - d.y2 * sy),
      y1: Math.min(page.height, page.height - d.y1 * sy),
    },
  }))
}

export interface LayoutAnalyzerOptions {
  modelPath: string
  minScore?: number
}

/** Runs the layout model on a PNG; returns detections in the PNG's pixel space plus its size. */
export async function analyzeLayoutImage(
  png: Uint8Array,
  options: LayoutAnalyzerOptions,
): Promise<{ detections: RawDetection[]; width: number; height: number }> {
  const canvasMod = await importOptional(
    '@napi-rs/canvas',
    'Layout analysis',
    () => import('@napi-rs/canvas'),
  )
  const [session, image] = await Promise.all([
    sessionFor(options.modelPath, 'Layout analysis'),
    canvasMod.loadImage(Buffer.from(png)),
  ])
  const rt = await import('onnxruntime-node')
  const canvas = canvasMod.createCanvas(INPUT_SIZE, INPUT_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE)
  const plane = INPUT_SIZE * INPUT_SIZE
  const tensor = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    tensor[i] = (data[i * 4] as number) / 255
    tensor[plane + i] = (data[i * 4 + 1] as number) / 255
    tensor[2 * plane + i] = (data[i * 4 + 2] as number) / 255
  }
  const feeds = {
    image: new rt.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    im_shape: new rt.Tensor('float32', new Float32Array([INPUT_SIZE, INPUT_SIZE]), [1, 2]),
    scale_factor: new rt.Tensor(
      'float32',
      new Float32Array([INPUT_SIZE / image.height, INPUT_SIZE / image.width]),
      [1, 2],
    ),
  }
  const out = await session.run(feeds)
  const first = out[session.outputNames[0] as string]
  if (!first) return { detections: [], width: image.width, height: image.height }
  const raw = parseDetections(first.data as ArrayLike<number>, first.dims)
  return {
    detections: selectDetections(raw, options.minScore ?? 0.5),
    width: image.width,
    height: image.height,
  }
}

export interface PageLike {
  pageCount: number
  renderPng(pageNumber: number, longSide?: number): Promise<Uint8Array>
  pageSize(pageNumber: number): Promise<{ width: number; height: number }>
}

/** What the PDF reader calls per page when layout analysis is on. */
export type PageLayoutProvider = (doc: PageLike, pageNumber: number) => Promise<LayoutRegion[]>

export interface LayoutProviderOptions {
  /** Longer page side in pixels for the render the model sees (default 1024). */
  render?: number
  minScore?: number
  cache?: CacheStore
  documentId?: string
  modelsDir?: string
  onModelDownload?: (done: number, total: number) => void
  onPage?: (pageNumber: number, pageCount: number) => void
  signal?: AbortSignal
}

const LAYOUT_CACHE_VERSION = 1

/** Downloads the model on first use and analyses pages, caching the regions per document page. */
export async function createLayoutProvider(options: LayoutProviderOptions = {}): Promise<PageLayoutProvider> {
  const modelPath = await ensureModel(LAYOUT_MODEL, {
    dir: options.modelsDir,
    onProgress: options.onModelDownload,
    signal: options.signal,
  })
  const render = options.render ?? 1024
  const minScore = options.minScore ?? 0.5
  return async (doc, pageNumber) => {
    const key = options.cache?.key(
      'layout',
      LAYOUT_CACHE_VERSION,
      LAYOUT_MODEL,
      options.documentId ?? '',
      pageNumber,
      render,
      minScore,
    )
    if (key && options.cache) {
      const hit = await options.cache.get<LayoutRegion[]>('layout', key)
      if (hit) {
        options.onPage?.(pageNumber, doc.pageCount)
        return hit
      }
    }
    const [png, size] = await Promise.all([doc.renderPng(pageNumber, render), doc.pageSize(pageNumber)])
    const { detections, width, height } = await analyzeLayoutImage(png, { modelPath, minScore })
    const regions = toRegions(detections, { width, height }, size)
    if (key && options.cache) await options.cache.set('layout', key, regions)
    options.onPage?.(pageNumber, doc.pageCount)
    return regions
  }
}
