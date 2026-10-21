import type { CacheStore } from '../cache/store.js'
import type { FormulaProvider } from '../documents/pdf.js'
import type { Rect } from '../documents/tables.js'
import { RagChunkerError } from '../errors.js'
import type { FormulaRecogniser } from '../local/formula.js'
import type { PageLike } from '../local/layout.js'
import { importOptional } from '../util/optional.js'

/**
 * The pipeline's formula provider: crops a display-formula region out of a page render (one render
 * per page, shared by the regions on it) and hands the crop to the recogniser; results are cached
 * per document region, like OCR pages. The recogniser itself is created on the first region, so a
 * document without formulas never loads (or downloads) the model.
 */

export interface FormulaProviderOptions {
  /** The recogniser, or a factory called on the first formula region. */
  recogniser: FormulaRecogniser | (() => Promise<FormulaRecogniser>)
  cache: CacheStore
  documentId: string
  /**
   * With `formulas.recognize: "on"` a recogniser that cannot run fails the document; otherwise the
   * first failure is reported once through `onWarn` and formulas stay as text.
   */
  required?: boolean
  /** Longer page side in pixels for the render the crops come from (default 2048). */
  render?: number
  signal?: AbortSignal
  onWarn?: (message: string) => void
}

export interface FormulaStats {
  recognised: number
  empty: number
  cached: number
  failed: number
}

export interface FormulaCollector {
  provider: FormulaProvider
  stats: FormulaStats
}

const FORMULA_CACHE_VERSION = 1
const MODEL_TAG = 'texify2-q8'
/** Padding around the region in PDF points, so no stroke is cut off. */
const CROP_PAD = 4

const loadCanvas = () =>
  importOptional('@napi-rs/canvas', 'Formula recognition', () => import('@napi-rs/canvas'))

export function createFormulaProvider(options: FormulaProviderOptions): FormulaCollector {
  const render = options.render ?? 2048
  const stats: FormulaStats = { recognised: 0, empty: 0, cached: 0, failed: 0 }
  let current: { page: number; img: Promise<{ img: unknown; width: number; height: number }> } | null = null
  let disabled = false
  let recogniser: Promise<FormulaRecogniser> | null =
    typeof options.recogniser === 'function' ? null : Promise.resolve(options.recogniser)
  const factory = typeof options.recogniser === 'function' ? options.recogniser : null

  /** Gives up on formulas for this document, or fails it when they are required. */
  const giveUp = (what: string, err: unknown): null => {
    if (options.signal?.aborted || (options.required && err instanceof RagChunkerError)) throw err
    if (!disabled) options.onWarn?.(`${what}: ${(err as Error).message}`)
    disabled = true
    return null
  }

  const provider: FormulaProvider = async (doc: PageLike, pageNumber: number, region: Rect) => {
    const key = options.cache.key(
      'formula',
      FORMULA_CACHE_VERSION,
      MODEL_TAG,
      options.documentId,
      pageNumber,
      Math.round(region.x0),
      Math.round(region.y0),
      Math.round(region.x1),
      Math.round(region.y1),
    )
    const cached = await options.cache.get<string | null>('formula', key)
    if (cached !== undefined) {
      stats.cached++
      return cached
    }
    if (disabled) return null
    let canvasMod: Awaited<ReturnType<typeof loadCanvas>>
    try {
      canvasMod = await loadCanvas()
    } catch (err) {
      return giveUp('Formulas are not recognised', err)
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
    const x0 = Math.max(0, Math.floor((region.x0 - CROP_PAD) * sx))
    const x1 = Math.min(image.width, Math.ceil((region.x1 + CROP_PAD) * sx))
    const y0 = Math.max(0, Math.floor((height - region.y1 - CROP_PAD) * sy))
    const y1 = Math.min(image.height, Math.ceil((height - region.y0 + CROP_PAD) * sy))
    const w = x1 - x0
    const h = y1 - y0
    if (w < 8 || h < 8) return null
    const canvas = canvasMod.createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img as Parameters<typeof ctx.drawImage>[0], x0, y0, w, h, 0, 0, w, h)
    const png = new Uint8Array(canvas.toBuffer('image/png'))
    if (!recogniser) {
      recogniser = (factory as () => Promise<FormulaRecogniser>)()
      recogniser.catch(() => {
        recogniser = null
      })
    }
    let ready: FormulaRecogniser
    try {
      ready = await recogniser
    } catch (err) {
      return giveUp('Formulas stay as text', err)
    }
    try {
      const latex = await ready.recognise(png, options.signal)
      if (latex) stats.recognised++
      else stats.empty++
      await options.cache.set('formula', key, latex)
      return latex
    } catch (err) {
      if (options.signal?.aborted) throw err
      stats.failed++
      options.onWarn?.(`Formula on page ${pageNumber} was not recognised: ${(err as Error).message}`)
      return null
    }
  }
  return { provider, stats }
}
