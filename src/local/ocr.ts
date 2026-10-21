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
  /** Which recogniser read the page. */
  script?: OcrScript
  /** True when the 'auto' probe had enough lines to decide the script. */
  probed?: boolean
  /** Set by the provider when the lines came from the cache (not stored). */
  cached?: boolean
}

/**
 * Longest side the detector sees (PaddleOCR's default 960), both sides multiples of 32. Dense pages with
 * small print (newspapers, high-resolution scans) need more; RAG_CHUNKER_OCR_DET_LIMIT overrides it
 * until it is a config option.
 */
const DET_LIMIT =
  Number(process.env.RAG_CHUNKER_OCR_DET_LIMIT) > 0 ? Number(process.env.RAG_CHUNKER_OCR_DET_LIMIT) : 960

/**
 * Second detection pass for dense pages: triggered when the median detected line is shorter than
 * this many pixels in the detector's input (0 disables; RAG_CHUNKER_OCR_DET_MIN_LINE overrides),
 * never beyond DET_MAX_LIMIT px on the longest side.
 */
const DET_MIN_LINE =
  process.env.RAG_CHUNKER_OCR_DET_MIN_LINE !== undefined
    ? Number(process.env.RAG_CHUNKER_OCR_DET_MIN_LINE) || 0
    : 12
const DET_MAX_LIMIT = 3200

export type OcrDetector = 'mobile' | 'server'

/**
 * Recogniser plan from a configuration: `ocr.script` ('auto' probes, 'latin'/'cjk' force) and
 * whether the CJK server model is downloaded at all (the "full" profile, or an explicit 'cjk').
 * RAG_CHUNKER_OCR_SCRIPT overrides the script for benchmarks.
 */
export function resolveOcrScript(
  config: { ocr: { script: 'auto' | OcrScript }; local: { profile: 'full' | 'basic' } },
  env: Record<string, string | undefined> = process.env,
): { script: OcrScript | 'auto'; cjk: boolean } {
  const override = env.RAG_CHUNKER_OCR_SCRIPT
  const script =
    override === 'latin' || override === 'cjk' || override === 'auto' ? override : config.ocr.script
  const cjk = script === 'cjk' || (script === 'auto' && config.local.profile === 'full')
  return { script: cjk ? script : 'latin', cjk }
}

/**
 * The detector a configuration asks for: an explicit `ocr.detector`, else the profile's choice
 * ("full" → server, "basic" → mobile). Returns undefined when the environment override
 * RAG_CHUNKER_OCR_DET_MODEL should decide (benchmarks set it without touching the config).
 */
export function resolveOcrDetector(
  config: { ocr: { detector: 'auto' | OcrDetector }; local: { profile: 'full' | 'basic' } },
  env: Record<string, string | undefined> = process.env,
): OcrDetector | undefined {
  if (config.ocr.detector !== 'auto') return config.ocr.detector
  if (env.RAG_CHUNKER_OCR_DET_MODEL) return undefined
  return config.local.profile === 'basic' ? 'mobile' : 'server'
}

/**
 * Which detector to run. An explicit choice wins; otherwise RAG_CHUNKER_OCR_DET_MODEL=server picks
 * the 84 MB server model (larger backbone: more table cells and small print, about 1.8× slower)
 * and anything else the 5 MB mobile model.
 */
export function ocrDetectorModel(
  choice?: OcrDetector,
  env: Record<string, string | undefined> = process.env,
): ModelId {
  const detector = choice ?? (env.RAG_CHUNKER_OCR_DET_MODEL === 'server' ? 'server' : 'mobile')
  return detector === 'server' ? 'pp-ocrv5-det-server' : OCR_DET_MODEL
}
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
  /** The server recogniser (Chinese, Japanese, English) for pages the Latin model cannot read. */
  cjk?: { rec: string; dictionary: string[] }
}

/** Which recogniser reads a page: the Latin mobile model or the CJK server model. */
export type OcrScript = 'latin' | 'cjk'

export interface RecognizeOptions {
  /**
   * 'latin' (default) or 'cjk' force a recogniser; 'auto' reads the widest lines with the CJK model
   * first and switches the page to it when they come back as CJK text. The Latin model's own
   * confidence cannot tell: it reads Chinese as confident Latin gibberish.
   */
  script?: OcrScript | 'auto'
}

/** Share of CJK characters (Han, kana, Hangul) among the non-space characters of a text. */
export function cjkShare(text: string): number {
  const chars = [...text.replace(/\s+/g, '')]
  if (chars.length === 0) return 0
  const cjk = chars.filter((c) => /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/u.test(c)).length
  return cjk / chars.length
}

/** How many of the widest lines the 'auto' probe reads with the CJK model. */
const SCRIPT_PROBE_LINES = 5

/**
 * The probe's verdict from what the CJK model read in the widest lines: a page is CJK when at
 * least a fifth of the probe's characters (and at least four) are CJK. Lines on Chinese exam
 * papers, tables and journals are often mostly digits and formulas, so a per-line majority rule
 * misses them; Latin lines read by the CJK model contain no CJK characters at all.
 */
export function probeSaysCjk(texts: readonly string[]): boolean {
  let total = 0
  let cjk = 0
  for (const t of texts) {
    const chars = t.replace(/\s+/g, '').length
    total += chars
    cjk += Math.round(cjkShare(t) * chars)
  }
  return cjk >= 4 && cjk >= total * 0.2
}

/** Recognises the text lines of an image (PNG/JPEG bytes). */
export async function recognizeImage(
  image: Uint8Array,
  models: OcrModelPaths,
  options: RecognizeOptions = {},
): Promise<OcrResult> {
  const canvasMod = await importOptional('@napi-rs/canvas', 'Local OCR', () => import('@napi-rs/canvas'))
  const rt = await import('onnxruntime-node')
  const [det, rec, img] = await Promise.all([
    sessionFor(models.det, 'Local OCR', { accelerate: true }),
    sessionFor(models.rec, 'Local OCR'),
    canvasMod.loadImage(Buffer.from(image)),
  ])

  // Detection on a bounded, 32-aligned resize of the page; channels in BGR order as PaddleOCR expects.
  const detect = async (limit: number) => {
    const scale = Math.min(1, limit / Math.max(img.width, img.height))
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
    if (!prob) return null
    const [, , ph = dh, pw = dw] = prob.dims
    const boxes = boxesFromProbabilityMap(prob.data as ArrayLike<number>, pw, ph)
    // Boxes in image pixels, plus the median line height as the detector saw it.
    const heights = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
    const median = heights.length ? (heights[heights.length >> 1] as number) : 0
    const sx = img.width / pw
    const sy = img.height / ph
    return {
      boxes: boxes.map((b) => ({ x0: b.x0 * sx, y0: b.y0 * sy, x1: b.x1 * sx, y1: b.y1 * sy })),
      median,
      scale,
    }
  }
  let detected = await detect(DET_LIMIT)
  if (!detected) return { lines: [], width: img.width, height: img.height }
  // Dense small print (newspapers, high-resolution scans): when the page had to be shrunk and the
  // typical line came out only a few pixels tall, the detector merges and loses lines. A second
  // pass at the resolution that makes a line about DET_MIN_LINE px tall finds them; pages whose
  // text is already large never pay for it.
  if (
    DET_MIN_LINE > 0 &&
    detected.scale < 1 &&
    detected.boxes.length >= 20 &&
    detected.median > 0 &&
    detected.median < DET_MIN_LINE
  ) {
    const wanted = Math.ceil((DET_LIMIT * ((DET_MIN_LINE + 2) / detected.median)) / 32) * 32
    const limit = Math.min(Math.max(img.width, img.height), DET_MAX_LIMIT, wanted)
    if (limit > DET_LIMIT) {
      const again = await detect(limit)
      if (again && again.boxes.length >= detected.boxes.length) detected = again
    }
  }

  const boxes = detected.boxes
    .map((b) => ({
      x0: Math.max(0, b.x0),
      y0: Math.max(0, b.y0),
      x1: Math.min(img.width, b.x1),
      y1: Math.min(img.height, b.y1),
    }))
    .filter((b) => b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2)

  type Recogniser = { session: Awaited<ReturnType<typeof sessionFor>>; dictionary: readonly string[] }
  const readLines = async (subset: typeof boxes, recogniser: Recogniser): Promise<OcrLine[]> => {
    const lines: OcrLine[] = []
    for (const { x0, y0, x1, y1 } of subset) {
      const cw = x1 - x0
      const ch = y1 - y0
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
      const recOut = await recogniser.session.run({
        [recogniser.session.inputNames[0] as string]: new rt.Tensor('float32', cin, [1, 3, REC_HEIGHT, rw]),
      })
      const logits = recOut[recogniser.session.outputNames[0] as string]
      if (!logits) continue
      const [, steps = 0, classes = 0] = logits.dims
      const table = tableFor(recogniser.dictionary, classes)
      const { text, confidence, chars } = ctcDecode(logits.data as ArrayLike<number>, steps, classes, table)
      if (text === '') continue
      const words = wordsFromChars(chars, steps, { x0, x1 })
      lines.push({ text, x0, y0, x1, y1, confidence, ...(words.length > 1 ? { words } : {}) })
    }
    return lines
  }

  const latin: Recogniser = { session: rec, dictionary: models.dictionary }
  const cjk: Recogniser | null = models.cjk
    ? {
        session: await sessionFor(models.cjk.rec, 'Local OCR', { accelerate: true }),
        dictionary: models.cjk.dictionary,
      }
    : null
  let script: OcrScript = options.script === 'cjk' && cjk ? 'cjk' : 'latin'
  let probed = false
  if (options.script === 'auto' && cjk && boxes.length > 0) {
    // The widest lines carry the most characters: read their first ten line-heights (eight or
    // more characters, enough to tell the script, a third of the cost of a full line) with the
    // CJK model and switch the page when enough of what comes back is CJK text.
    const sample = [...boxes]
      .sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))
      .slice(0, SCRIPT_PROBE_LINES)
      .map((b) => ({ ...b, x1: Math.min(b.x1, b.x0 + 10 * (b.y1 - b.y0)) }))
    const probe = await readLines(sample, cjk)
    if (probeSaysCjk(probe.map((l) => l.text))) script = 'cjk'
    probed = sample.length >= 2
  }
  const lines = await readLines(boxes, script === 'cjk' ? (cjk as Recogniser) : latin)
  return { lines, width: img.width, height: img.height, script, ...(probed ? { probed } : {}) }
}

/** What the PDF reader calls for a scanned page: text lines in the pixels of the render it is given. */
export type PageOcrProvider = (doc: PageLike, pageNumber: number) => Promise<OcrResult>

export interface OcrProviderOptions {
  /** Longer page side in pixels rendered for OCR (default 2000). */
  render?: number
  /** Text detector: the mobile model or the larger server model (default: see `ocrDetectorModel`). */
  detector?: OcrDetector
  /** Recogniser choice per page: 'latin' (default), 'cjk', or 'auto' (probe; needs `cjk`). */
  script?: OcrScript | 'auto'
  /** Download and hold the CJK server recogniser (84 MB) so 'auto' and 'cjk' can use it. */
  cjk?: boolean
  cache?: CacheStore
  documentId?: string
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
}

const OCR_CACHE_VERSION = 1

/** Downloads the OCR models on first use (13–97 MB, see local.profile) and returns a per-page recogniser with caching. */
export async function createOcrProvider(options: OcrProviderOptions = {}): Promise<{
  models: OcrModelPaths
  page: PageOcrProvider
  image: (bytes: Uint8Array, options?: { rotation?: number }) => Promise<OcrResult>
}> {
  const models = await loadOcrModels(options)
  const render = options.render ?? 2000
  const scriptMode: OcrScript | 'auto' = models.cjk ? (options.script ?? 'latin') : 'latin'
  // A document is read in one script: the first page with enough lines decides for the rest.
  let decided: OcrScript | null = scriptMode === 'auto' ? null : scriptMode
  // Everything that changes the lines is in the key: models, detector input size and second pass,
  // the script mode, the document, the page (or the image itself) and the render size.
  const keyFor = (...part: Array<string | number>) =>
    options.cache?.key(
      'ocr-local',
      OCR_CACHE_VERSION,
      OCR_REC_MODEL,
      ocrDetectorModel(options.detector),
      DET_LIMIT,
      DET_MIN_LINE,
      DET_MAX_LIMIT,
      scriptMode,
      options.documentId ?? '',
      ...part,
    )
  const page: PageOcrProvider = async (doc, pageNumber) => {
    const key = keyFor(pageNumber, render, doc.rotation?.(pageNumber) ?? 0)
    if (key && options.cache) {
      const hit = await options.cache.get<OcrResult>('ocr-local', key)
      if (hit) {
        if (decided === null && hit.probed && hit.script) decided = hit.script
        return { ...hit, cached: true }
      }
    }
    const png = await doc.renderPng(pageNumber, render)
    const result = await recognizeImage(png, models, { script: decided ?? 'auto' })
    if (decided === null && result.probed && result.script) decided = result.script
    if (key && options.cache) await options.cache.set('ocr-local', key, result)
    return result
  }
  // A standalone image is one page: its lines are cached like a PDF page's (the page itself is
  // composed again on every run, so layout and table settings take effect).
  const image = async (bytes: Uint8Array, imageOptions: { rotation?: number } = {}): Promise<OcrResult> => {
    const key = options.documentId ? keyFor('image', imageOptions.rotation ?? 0) : undefined
    if (key && options.cache) {
      const hit = await options.cache.get<OcrResult>('ocr-local', key)
      if (hit) return { ...hit, cached: true }
    }
    const result = await recognizeImage(bytes, models, { script: scriptMode })
    if (key && options.cache) await options.cache.set('ocr-local', key, result)
    return result
  }
  return { models, page, image }
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
  const [det, rec, dictPath, cjkRec, cjkDictPath] = await Promise.all([
    fetchOne(ocrDetectorModel(options.detector)),
    fetchOne(OCR_REC_MODEL),
    fetchOne(OCR_DICT),
    options.cjk ? fetchOne('pp-ocrv5-rec-server') : Promise.resolve(null),
    options.cjk ? fetchOne('pp-ocrv5-dict-server') : Promise.resolve(null),
  ])
  const dictionary = parseDictionary(await readFile(dictPath, 'utf8'))
  const cjk =
    cjkRec && cjkDictPath
      ? { rec: cjkRec, dictionary: parseDictionary(await readFile(cjkDictPath, 'utf8')) }
      : undefined
  return { det, rec, dictionary, ...(cjk ? { cjk } : {}) }
}
