import type { CacheStore } from '../cache/store.js'
import { importOptional } from '../util/optional.js'
import type { PageLike } from './layout.js'
import { ensureModel, type ModelId } from './models.js'
import { sessionFor } from './runtime.js'

/**
 * Page orientation. PP-LCNet_x1_0_doc_ori (PaddleOCR's document orientation classifier, 7 MB)
 * says whether a page image is upright or turned by 90, 180 or 270 degrees. Scanned pages and
 * images are turned upright before layout analysis and OCR, every later stage works in the
 * upright frame, and the page records its rotation so a viewer can match boxes to the original.
 */

export const ORIENTATION_MODEL: ModelId = 'pp-lcnet-doc-ori'

/** Clockwise angle the page content is turned by; 0 is upright. */
export type Rotation = 0 | 90 | 180 | 270

/**
 * Minimum class scores for turning a page, measured with this very preprocessing on the 1,651
 * OmniDocBench pages. 90/270: at ≥ 0.75 the model turns 9 sideways pages (tables printed across the
 * page) and one upright cover with a vertical title; below it come upright pages. 180: every call
 * under 0.9 was an upright page (forms and tables of contents up to 0.86), while pages turned by
 * 180 degrees on purpose score 0.92–0.93. Below the threshold the page is left as it is.
 */
export const ORIENTATION_MIN_SCORE = 0.75
export const ORIENTATION_MIN_SCORE_180 = 0.9

const INPUT_SIZE = 224
const RESIZE_SHORT = 256
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const
/** Index order of the model's classes. */
const LABELS: readonly Rotation[] = [0, 90, 180, 270]

export interface OrientationResult {
  /** The rotation to undo; 0 when the page is upright or the model is not sure enough. */
  rotation: Rotation
  /** Score of the winning class, whichever it was. */
  score: number
}

export type OrientationClassifier = (png: Uint8Array) => Promise<OrientationResult>

export interface OrientationClassifierOptions {
  modelsDir?: string
  minScore?: number
  onModelDownload?: (done: number, total: number) => void
  signal?: AbortSignal
}

type CanvasModule = typeof import('@napi-rs/canvas')

async function loadCanvas(): Promise<CanvasModule> {
  return importOptional('@napi-rs/canvas', 'Page orientation', () => import('@napi-rs/canvas'))
}

/** Downloads the model on first use and returns a classifier for page images (PNG or JPEG). */
export async function createOrientationClassifier(
  options: OrientationClassifierOptions = {},
): Promise<OrientationClassifier> {
  const modelPath = await ensureModel(ORIENTATION_MODEL, {
    dir: options.modelsDir,
    onProgress: options.onModelDownload,
    signal: options.signal,
  })
  const minScore = options.minScore ?? ORIENTATION_MIN_SCORE
  return async (png) => decideRotation(await classifyImage(png, modelPath), minScore)
}

/**
 * The winning class as a rotation, kept only when its score reaches `minScore` (90 and 270) or
 * `ORIENTATION_MIN_SCORE_180` (180, where the model is less reliable on upright pages).
 */
export function decideRotation(
  scores: readonly number[],
  minScore = ORIENTATION_MIN_SCORE,
): OrientationResult {
  let best = 0
  for (let i = 1; i < scores.length; i++) if ((scores[i] as number) > (scores[best] as number)) best = i
  const score = scores[best] ?? 0
  const rotation = LABELS[best] ?? 0
  const needed = rotation === 180 ? Math.max(minScore, ORIENTATION_MIN_SCORE_180) : minScore
  return { rotation: score >= needed ? rotation : 0, score }
}

/** Class scores of the four orientations for one image, in the model's label order. */
export async function classifyImage(png: Uint8Array, modelPath: string): Promise<number[]> {
  const canvasMod = await loadCanvas()
  const [session, image] = await Promise.all([
    sessionFor(modelPath, 'Page orientation'),
    canvasMod.loadImage(Buffer.from(png)),
  ])
  const rt = await import('onnxruntime-node')
  // PaddleClas preprocessing: short side to 256, centre crop 224, ImageNet mean/std, CHW.
  const scale = RESIZE_SHORT / Math.min(image.width, image.height)
  const w = Math.max(INPUT_SIZE, Math.round(image.width * scale))
  const h = Math.max(INPUT_SIZE, Math.round(image.height * scale))
  const canvas = canvasMod.createCanvas(INPUT_SIZE, INPUT_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE)
  ctx.drawImage(image, Math.floor((INPUT_SIZE - w) / 2), Math.floor((INPUT_SIZE - h) / 2), w, h)
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE)
  const plane = INPUT_SIZE * INPUT_SIZE
  const tensor = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      tensor[c * plane + i] = ((data[i * 4 + c] as number) / 255 - MEAN[c as 0 | 1 | 2]) / STD[c as 0 | 1 | 2]
    }
  }
  const out = await session.run({ x: new rt.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]) })
  const first = out[session.outputNames[0] as string]
  const raw = first ? Array.from(first.data as ArrayLike<number>).slice(0, LABELS.length) : []
  return softmaxIfNeeded(raw)
}

/** The exported model ends in a softmax; logits are normalised here in case an export does not. */
function softmaxIfNeeded(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  if (values.every((v) => v >= 0 && v <= 1) && Math.abs(sum - 1) < 0.01) return values
  const max = Math.max(...values)
  const exp = values.map((v) => Math.exp(v - max))
  const total = exp.reduce((a, b) => a + b, 0)
  return exp.map((e) => e / total)
}

/**
 * Turns an image upright: the content was turned `rotation` degrees clockwise, so the image is
 * turned back by the same angle. 90 and 270 swap width and height. Returns PNG bytes.
 */
export async function turnUpright(png: Uint8Array, rotation: Rotation): Promise<Uint8Array> {
  if (rotation === 0) return png
  const canvasMod = await loadCanvas()
  const image = await canvasMod.loadImage(Buffer.from(png))
  const swap = rotation === 90 || rotation === 270
  const width = swap ? image.height : image.width
  const height = swap ? image.width : image.height
  const canvas = canvasMod.createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2)
  // Canvas angles are clockwise (y grows downwards): a negative angle turns the content back.
  ctx.rotate((-rotation * Math.PI) / 180)
  ctx.drawImage(image, -image.width / 2, -image.height / 2)
  return new Uint8Array(canvas.toBuffer('image/png'))
}

/** A page source whose scanned pages are turned upright once their orientation is decided. */
export interface OrientedPages extends PageLike {
  /** Decides the page's orientation (once per page) and returns it; later renders come out upright. */
  orient(pageNumber: number): Promise<OrientationResult>
}

export interface OrientPagesOptions {
  cache?: CacheStore
  documentId?: string
}

const ORIENTATION_CACHE_VERSION = 1
/** Longer side of the render the classifier sees; its short side stays above the model's 256. */
const DECIDE_RENDER = 640

/**
 * Wraps a page source: `orient(n)` classifies the page (cached per document page), after which
 * `renderPng(n)` returns the page turned upright and `pageSize(n)` its upright size. Pages that
 * were never oriented pass through unchanged, so text-layer pages cost nothing.
 */
export function orientPages(
  doc: PageLike,
  classify: OrientationClassifier,
  options: OrientPagesOptions = {},
): OrientedPages {
  const rotations = new Map<number, Rotation>()
  const pending = new Map<number, Promise<OrientationResult>>()
  const orient = (pageNumber: number): Promise<OrientationResult> => {
    let p = pending.get(pageNumber)
    if (!p) {
      p = (async () => {
        const key = options.cache?.key(
          'orientation',
          ORIENTATION_CACHE_VERSION,
          ORIENTATION_MODEL,
          options.documentId ?? '',
          pageNumber,
          DECIDE_RENDER,
        )
        let result =
          key && options.cache ? await options.cache.get<OrientationResult>('orientation', key) : undefined
        if (!result) {
          result = await classify(await doc.renderPng(pageNumber, DECIDE_RENDER))
          if (key && options.cache) await options.cache.set('orientation', key, result)
        }
        rotations.set(pageNumber, result.rotation)
        return result
      })()
      p.catch(() => pending.delete(pageNumber))
      pending.set(pageNumber, p)
    }
    return p
  }
  return {
    get pageCount() {
      return doc.pageCount
    },
    orient,
    rotation: (pageNumber) => rotations.get(pageNumber) ?? 0,
    renderPng: async (pageNumber, longSide) => {
      const png = await doc.renderPng(pageNumber, longSide)
      return turnUpright(png, rotations.get(pageNumber) ?? 0)
    },
    pageSize: async (pageNumber) => {
      const size = await doc.pageSize(pageNumber)
      const rotation = rotations.get(pageNumber) ?? 0
      return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size
    },
  }
}
