import type { CacheStore } from '../cache/store.js'
import type { FigureData, FigureFile, FigureSink } from '../documents/figures.js'
import type { Box } from '../documents/layout.js'
import type { Rect } from '../documents/tables.js'
import type { PageLike } from '../local/layout.js'
import { describeFigure, FIGURE_PROMPT_VERSION } from '../ocr/vision.js'
import type { LLM, Usage } from '../providers/types.js'
import { addUsage, emptyUsage } from '../providers/types.js'
import { importOptional } from '../util/optional.js'

/**
 * The pipeline's figure sink: crops every figure the readers report out of a page render, keeps the
 * PNG for `save()` and, when asked, has a vision model describe it (cached per document region).
 */

export interface FigureSinkOptions {
  cache: CacheStore
  documentId: string
  /** Longer page side in pixels for the render the crops come from (default 2048). */
  render?: number
  /** Vision model that describes each figure; absent = no descriptions. */
  describe?: { llm: LLM; model: string }
  onWarn?: (message: string) => void
  signal?: AbortSignal
}

export interface FigureCollector {
  save: FigureSink
  files: FigureFile[]
  stats: { extracted: number; described: number; cached: number }
  usage: Usage
}

const FIGURE_CACHE_VERSION = 1
const CROP_PAD = 2

export function createFigureSink(options: FigureSinkOptions): FigureCollector {
  const files: FigureFile[] = []
  const stats = { extracted: 0, described: 0, cached: 0 }
  const usage = emptyUsage()
  const perPage = new Map<number, number>()
  const render = options.render ?? 2048
  let current: { page: number; img: Promise<{ img: unknown; width: number; height: number }> } | null = null
  let canvasMissing = false

  const save: FigureSink = async (doc, pageNumber, figure) => {
    if (canvasMissing) return null
    let canvasMod: Awaited<ReturnType<typeof loadCanvas>>
    try {
      canvasMod = await loadCanvas()
    } catch (err) {
      canvasMissing = true
      options.onWarn?.(`Figures are not extracted: ${(err as Error).message}`)
      return null
    }
    if (!current || current.page !== pageNumber) {
      current = {
        page: pageNumber,
        img: Promise.all([doc.renderPng(pageNumber, render), doc.pageSize(pageNumber)]).then(
          async ([png, size]) => ({ img: await canvasMod.loadImage(Buffer.from(png)), ...size }),
        ),
      }
    }
    const { img, width, height } = await current.img
    const image = img as { width: number; height: number }
    const sx = image.width / width
    const sy = image.height / height
    const b = figure.bbox
    const x0 = Math.max(0, Math.floor((b.x0 - CROP_PAD) * sx))
    const x1 = Math.min(image.width, Math.ceil((b.x1 + CROP_PAD) * sx))
    const y0 = Math.max(0, Math.floor((height - b.y1 - CROP_PAD) * sy))
    const y1 = Math.min(image.height, Math.ceil((height - b.y0 + CROP_PAD) * sy))
    const w = x1 - x0
    const h = y1 - y0
    if (w < 8 || h < 8) return null
    const canvas = canvasMod.createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img as Parameters<typeof ctx.drawImage>[0], x0, y0, w, h, 0, 0, w, h)
    const bytes = new Uint8Array(canvas.toBuffer('image/png'))
    const n = (perPage.get(pageNumber) ?? 0) + 1
    perPage.set(pageNumber, n)
    const file = `figures/p${pageNumber}-${n}.png`
    const data: FigureData = {
      file,
      label: figure.label,
      ...(figure.caption ? { caption: figure.caption } : {}),
    }
    if (options.describe) {
      const description = await describe(bytes, figure.caption, figure.nearby, figure.bbox, pageNumber)
      if (description) data.description = description
    }
    files.push({
      file,
      bytes,
      page: pageNumber,
      box: round({
        x: b.x0 / width,
        y: (height - b.y1) / height,
        w: (b.x1 - b.x0) / width,
        h: (b.y1 - b.y0) / height,
      }),
      label: figure.label,
      ...(figure.caption ? { caption: figure.caption } : {}),
      ...(data.description ? { description: data.description } : {}),
    })
    stats.extracted++
    return data
  }

  const describe = async (
    png: Uint8Array,
    caption: string | undefined,
    nearby: string | undefined,
    bbox: Rect,
    page: number,
  ): Promise<string | null> => {
    const { llm, model } = options.describe as NonNullable<FigureSinkOptions['describe']>
    const key = options.cache.key(
      'figure',
      FIGURE_CACHE_VERSION,
      options.documentId,
      page,
      [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((v) => Math.round(v)),
      model,
      FIGURE_PROMPT_VERSION,
    )
    const cached = await options.cache.get<string>('figure', key)
    if (cached !== undefined) {
      stats.cached++
      stats.described++
      return cached || null
    }
    try {
      const res = await describeFigure(llm, png, { caption, nearby }, options.signal)
      addUsage(usage, res.usage)
      await options.cache.set('figure', key, res.text)
      if (res.text) stats.described++
      return res.text || null
    } catch (err) {
      if (options.signal?.aborted) throw err
      options.onWarn?.(`Figure on page ${page} was not described: ${(err as Error).message}`)
      return null
    }
  }

  return { save, files, stats, usage }
}

function loadCanvas() {
  return importOptional('@napi-rs/canvas', 'Figure extraction', () => import('@napi-rs/canvas'))
}

const round = (b: Box): Box => ({
  x: Math.round(b.x * 10_000) / 10_000,
  y: Math.round(b.y * 10_000) / 10_000,
  w: Math.round(b.w * 10_000) / 10_000,
  h: Math.round(b.h * 10_000) / 10_000,
})

export type { FigureFile, PageLike }
