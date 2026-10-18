import type { CacheStore } from '../cache/store.js'
import { importOptional } from '../util/optional.js'
import type { PageLike } from './layout.js'
import { ensureModel, type ModelId } from './models.js'
import { sessionFor } from './runtime.js'

/**
 * Local OCR with PP-OCRv5 mobile: a DBNet text detector finds text lines on the page image, a
 * CTC recogniser reads each line. Both are small ONNX models (5 MB + 8 MB) that run on the CPU.
 */

export const OCR_DET_MODEL: ModelId = 'pp-ocrv5-det'
export const OCR_REC_MODEL: ModelId = 'pp-ocrv5-rec-latin'
export const OCR_DICT: ModelId = 'pp-ocrv5-dict-latin'

/** A recognised text line in image pixels, origin top-left. */
export interface OcrWord {
  text: string
  /** Horizontal extent in the pixels of the OCR'd image. */
  x0: number
  x1: number
  confidence: number
}

export interface OcrLine {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** Mean per-character confidence (0-1). */
  confidence: number
  /** The line's words with their horizontal extent, from the CTC time steps; absent for one word. */
  words?: OcrWord[]
}

/** A decoded character with the recognition time step it came out of. */
export interface DecodedChar {
  char: string
  step: number
  confidence: number
}

export interface OcrResult {
  lines: OcrLine[]
  width: number
  height: number
}

/** Detector input: longest side at most this many pixels, both sides multiples of 32. */
const DET_LIMIT = 960
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]
/** DBNet thresholds: pixel probability, box score, expansion of the shrunk text region. */
const PIXEL_THRESHOLD = 0.3
const BOX_THRESHOLD = 0.5
const UNCLIP_RATIO = 1.5
const MIN_PIXELS = 10
/** Recogniser input height and the widest crop it is given. */
const REC_HEIGHT = 48
const REC_MAX_WIDTH = 1600

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

/**
 * Text regions from the detector's probability map: connected components above the pixel
 * threshold, scored by their mean probability and expanded back by the DBNet unclip offset.
 */
export function boxesFromProbabilityMap(prob: ArrayLike<number>, width: number, height: number): Box[] {
  const seen = new Uint8Array(width * height)
  const boxes: Box[] = []
  const stack: number[] = []
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || (prob[start] as number) < PIXEL_THRESHOLD) continue
    let x0 = width
    let x1 = -1
    let y0 = height
    let y1 = -1
    let n = 0
    let sum = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const i = stack.pop() as number
      const x = i % width
      const y = (i - x) / width
      n++
      sum += prob[i] as number
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && !seen[i - 1] && (prob[i - 1] as number) >= PIXEL_THRESHOLD) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x < width - 1 && !seen[i + 1] && (prob[i + 1] as number) >= PIXEL_THRESHOLD) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && !seen[i - width] && (prob[i - width] as number) >= PIXEL_THRESHOLD) {
        seen[i - width] = 1
        stack.push(i - width)
      }
      if (y < height - 1 && !seen[i + width] && (prob[i + width] as number) >= PIXEL_THRESHOLD) {
        seen[i + width] = 1
        stack.push(i + width)
      }
    }
    const score = sum / n
    if (n < MIN_PIXELS || score < BOX_THRESHOLD) continue
    // The detector predicts a shrunk text core; grow it back (Vatti offset of the DB paper).
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const offset = (w * h * UNCLIP_RATIO) / (2 * (w + h))
    boxes.push({ x0: x0 - offset, y0: y0 - offset, x1: x1 + 1 + offset, y1: y1 + 1 + offset, score })
  }
  return boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
}

/** The recogniser's character list: one character per line; index 0 is the CTC blank. */
export function parseDictionary(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines[0] !== '') lines.unshift('')
  return lines
}

/** The dictionary sized to the model's output classes: PaddleOCR appends a space as the last class. */
export function tableFor(dictionary: readonly string[], classes: number): string[] {
  const table = dictionary.slice(0, classes)
  while (table.length < classes) table.push(' ')
  return table
}

/** Greedy CTC decoding of one sequence: collapse repeats, drop blanks, average the confidences. */
export function ctcDecode(
  logits: ArrayLike<number>,
  steps: number,
  classes: number,
  table: readonly string[],
): { text: string; confidence: number; chars: DecodedChar[] } {
  const chars: DecodedChar[] = []
  let last = -1
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestValue = Number.NEGATIVE_INFINITY
    const base = t * classes
    for (let c = 0; c < classes; c++) {
      const v = logits[base + c] as number
      if (v > bestValue) {
        bestValue = v
        best = c
      }
    }
    if (best !== 0 && best !== last) chars.push({ char: table[best] ?? '', step: t, confidence: bestValue })
    last = best
  }
  // Leading and trailing blanks carry no text.
  while (chars.length > 0 && (chars[0] as DecodedChar).char.trim() === '') chars.shift()
  while (chars.length > 0 && (chars[chars.length - 1] as DecodedChar).char.trim() === '') chars.pop()
  const text = chars.map((c) => c.char).join('')
  const confidence = chars.length > 0 ? chars.reduce((s, c) => s + c.confidence, 0) / chars.length : 0
  return { text, confidence, chars }
}

/**
 * Words of a recognised line with their horizontal extent: every CTC step stands for an equal
 * slice of the line, so a word runs from the slice of its first character to that of its last.
 */
export function wordsFromChars(
  chars: readonly DecodedChar[],
  steps: number,
  line: { x0: number; x1: number },
): OcrWord[] {
  const width = line.x1 - line.x0
  if (steps <= 0 || width <= 0) return []
  const slice = width / steps
  const words: OcrWord[] = []
  let current: DecodedChar[] = []
  const flush = () => {
    if (current.length === 0) return
    const first = current[0] as DecodedChar
    const lastChar = current[current.length - 1] as DecodedChar
    words.push({
      text: current.map((c) => c.char).join(''),
      x0: Math.max(line.x0, line.x0 + first.step * slice),
      x1: Math.min(line.x1, line.x0 + (lastChar.step + 1) * slice),
      confidence: current.reduce((s, c) => s + c.confidence, 0) / current.length,
    })
    current = []
  }
  for (const c of chars) {
    if (c.char.trim() === '') flush()
    else current.push(c)
  }
  flush()
  return words
}

export interface OcrModelPaths {
  det: string
  rec: string
  dictionary: string[]
}

/** Recognises the text lines of an image (PNG/JPEG bytes). */
export async function recognizeImage(image: Uint8Array, models: OcrModelPaths): Promise<OcrResult> {
  const canvasMod = await importOptional('@napi-rs/canvas', 'Local OCR', () => import('@napi-rs/canvas'))
  const rt = await import('onnxruntime-node')
  const [det, rec, img] = await Promise.all([
    sessionFor(models.det, 'Local OCR'),
    sessionFor(models.rec, 'Local OCR'),
    canvasMod.loadImage(Buffer.from(image)),
  ])

  // Detection on a bounded, 32-aligned resize of the page; channels in BGR order as PaddleOCR expects.
  const scale = Math.min(1, DET_LIMIT / Math.max(img.width, img.height))
  const dw = Math.max(32, Math.round((img.width * scale) / 32) * 32)
  const dh = Math.max(32, Math.round((img.height * scale) / 32) * 32)
  const canvas = canvasMod.createCanvas(dw, dh)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, dw, dh)
  const { data } = ctx.getImageData(0, 0, dw, dh)
  const plane = dw * dh
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const r = (data[i * 4] as number) / 255
    const g = (data[i * 4 + 1] as number) / 255
    const b = (data[i * 4 + 2] as number) / 255
    input[i] = (b - (DET_MEAN[0] as number)) / (DET_STD[0] as number)
    input[plane + i] = (g - (DET_MEAN[1] as number)) / (DET_STD[1] as number)
    input[2 * plane + i] = (r - (DET_MEAN[2] as number)) / (DET_STD[2] as number)
  }
  const detOut = await det.run({
    [det.inputNames[0] as string]: new rt.Tensor('float32', input, [1, 3, dh, dw]),
  })
  const prob = detOut[det.outputNames[0] as string]
  if (!prob) return { lines: [], width: img.width, height: img.height }
  const [, , ph = dh, pw = dw] = prob.dims
  const boxes = boxesFromProbabilityMap(prob.data as ArrayLike<number>, pw, ph)
  const sx = img.width / pw
  const sy = img.height / ph

  const lines: OcrLine[] = []
  for (const b of boxes) {
    const x0 = Math.max(0, b.x0 * sx)
    const y0 = Math.max(0, b.y0 * sy)
    const x1 = Math.min(img.width, b.x1 * sx)
    const y1 = Math.min(img.height, b.y1 * sy)
    const cw = x1 - x0
    const ch = y1 - y0
    if (cw < 2 || ch < 2) continue
    const rw = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((cw * REC_HEIGHT) / ch)))
    const crop = canvasMod.createCanvas(rw, REC_HEIGHT)
    const cctx = crop.getContext('2d')
    cctx.drawImage(img, x0, y0, cw, ch, 0, 0, rw, REC_HEIGHT)
    const cd = cctx.getImageData(0, 0, rw, REC_HEIGHT).data
    const cplane = rw * REC_HEIGHT
    const cin = new Float32Array(3 * cplane)
    for (let i = 0; i < cplane; i++) {
      cin[i] = (cd[i * 4 + 2] as number) / 127.5 - 1
      cin[cplane + i] = (cd[i * 4 + 1] as number) / 127.5 - 1
      cin[2 * cplane + i] = (cd[i * 4] as number) / 127.5 - 1
    }
    const recOut = await rec.run({
      [rec.inputNames[0] as string]: new rt.Tensor('float32', cin, [1, 3, REC_HEIGHT, rw]),
    })
    const logits = recOut[rec.outputNames[0] as string]
    if (!logits) continue
    const [, steps = 0, classes = 0] = logits.dims
    const table = tableFor(models.dictionary, classes)
    const { text, confidence, chars } = ctcDecode(logits.data as ArrayLike<number>, steps, classes, table)
    if (text === '') continue
    const words = wordsFromChars(chars, steps, { x0, x1 })
    lines.push({ text, x0, y0, x1, y1, confidence, ...(words.length > 1 ? { words } : {}) })
  }
  return { lines, width: img.width, height: img.height }
}

/** What the PDF reader calls for a scanned page: text lines in the pixels of the render it is given. */
export type PageOcrProvider = (doc: PageLike, pageNumber: number) => Promise<OcrResult>

export interface OcrProviderOptions {
  /** Longer page side in pixels rendered for OCR (default 2000). */
  render?: number
  cache?: CacheStore
  documentId?: string
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
}

const OCR_CACHE_VERSION = 1

/** Downloads the OCR models on first use (13 MB) and returns a per-page recogniser with caching. */
export async function createOcrProvider(options: OcrProviderOptions = {}): Promise<{
  models: OcrModelPaths
  page: PageOcrProvider
  image: (bytes: Uint8Array) => Promise<OcrResult>
}> {
  const models = await loadOcrModels(options)
  const render = options.render ?? 2000
  const page: PageOcrProvider = async (doc, pageNumber) => {
    const key = options.cache?.key(
      'ocr-local',
      OCR_CACHE_VERSION,
      OCR_REC_MODEL,
      options.documentId ?? '',
      pageNumber,
      render,
    )
    if (key && options.cache) {
      const hit = await options.cache.get<OcrResult>('ocr-local', key)
      if (hit) return hit
    }
    const png = await doc.renderPng(pageNumber, render)
    const result = await recognizeImage(png, models)
    if (key && options.cache) await options.cache.set('ocr-local', key, result)
    return result
  }
  return { models, page, image: (bytes) => recognizeImage(bytes, models) }
}

/** Paths of the detector, recogniser and its character table, downloading what is missing. */
export async function loadOcrModels(options: OcrProviderOptions = {}): Promise<OcrModelPaths> {
  const { readFile } = await import('node:fs/promises')
  const fetchOne = (id: ModelId) =>
    ensureModel(id, {
      dir: options.modelsDir,
      signal: options.signal,
      onProgress: (done, total) => options.onModelDownload?.(id, done, total),
    })
  const [det, rec, dictPath] = await Promise.all([
    fetchOne(OCR_DET_MODEL),
    fetchOne(OCR_REC_MODEL),
    fetchOne(OCR_DICT),
  ])
  const dictionary = parseDictionary(await readFile(dictPath, 'utf8'))
  return { det, rec, dictionary }
}
