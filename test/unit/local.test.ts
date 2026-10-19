import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseDetections, selectDetections, toRegions } from '../../src/local/layout.js'
import { downloadModel, hasModel, MODELS, modelPath, modelsDir } from '../../src/local/models.js'
import {
  boxesFromProbabilityMap,
  cjkShare,
  ctcDecode,
  ocrDetectorModel,
  parseDictionary,
  resolveOcrDetector,
  resolveOcrScript,
  tableFor,
} from '../../src/local/ocr.js'
import { MockServer } from '../helpers/mock-server.js'

describe('layout detections', () => {
  it('parses rows, keeps confident boxes, drops duplicates and orders by reading order', () => {
    const rows = [
      [22, 0.9, 10, 10, 100, 50, 3], // text
      [22, 0.8, 12, 12, 98, 48, 7], // same text box again (contained) → dropped
      [17, 0.95, 10, 60, 100, 80, 1], // paragraph_title
      [21, 0.3, 0, 0, 50, 50, 0], // below threshold
      [14, 0.7, 10, 60, 100, 80, 2], // image with IoU 1 against the title → dropped (lower score)
    ].flat()
    const parsed = parseDetections(rows, [5, 7])
    expect(parsed).toHaveLength(5)
    const kept = selectDetections(parsed, 0.5)
    expect(kept.map((d) => [d.cls, d.order])).toEqual([
      [17, 1],
      [22, 3],
    ])
  })

  it('maps image pixels to PDF points with the y axis flipped', () => {
    const [r] = toRegions(
      [{ cls: 6, score: 0.9, x1: 100, y1: 0, x2: 500, y2: 100, order: 0 }],
      { width: 1000, height: 2000 },
      { width: 500, height: 1000 },
    )
    expect(r).toMatchObject({ label: 'doc_title', bbox: { x0: 50, x1: 250, y0: 950, y1: 1000 } })
  })
})

describe('local OCR building blocks', () => {
  it('reads the character table with a leading blank and a trailing space class', () => {
    const dict = parseDictionary('\n0\n1\na\nç\n')
    expect(dict).toEqual(['', '0', '1', 'a', 'ç'])
    expect(parseDictionary('0\n1\n')).toEqual(['', '0', '1'])
    expect(tableFor(dict, 6)).toEqual(['', '0', '1', 'a', 'ç', ' '])
    expect(tableFor(dict, 3)).toEqual(['', '0', '1'])
  })

  it('decodes CTC output greedily: repeats collapse, blanks drop, confidence averages', () => {
    const table = ['', 'a', 'b', ' ']
    const rows = [
      [0.1, 0.9, 0, 0],
      [0.2, 0.8, 0, 0],
      [0.9, 0.1, 0, 0],
      [0, 0, 0.7, 0.3],
      [0, 0, 0.6, 0.4],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [0, 0, 0, 1],
      [0, 0.5, 0.3, 0.2],
    ]
    const { text, confidence } = ctcDecode(rows.flat(), rows.length, 4, table)
    expect(text).toBe('ab a')
    expect(confidence).toBeCloseTo((0.9 + 0.7 + 1 + 0.5) / 4, 5)
  })

  it('turns a probability map into expanded, scored text boxes in reading order', () => {
    const w = 40
    const h = 20
    const prob = new Float32Array(w * h)
    const paint = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) prob[y * w + x] = v
    }
    paint(2, 2, 20, 4, 0.9)
    paint(2, 10, 30, 12, 0.8)
    paint(35, 15, 36, 15, 0.9)
    paint(25, 2, 30, 4, 0.4)
    const boxes = boxesFromProbabilityMap(prob, w, h)
    expect(boxes).toHaveLength(2)
    const [a, b] = boxes as [(typeof boxes)[number], (typeof boxes)[number]]
    expect(a.y0).toBeLessThan(b.y0)
    expect(a.score).toBeCloseTo(0.9, 5)
    expect(a.x0).toBeLessThan(2)
    expect(a.x1).toBeGreaterThan(21)
    expect(a.y0).toBeLessThan(2)
  })
})

describe('model files', () => {
  const server = new MockServer()
  const bytes = Buffer.from('not really a model, but enough to verify a hash')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  beforeAll(async () => {
    await server.start()
  })
  afterAll(async () => {
    await server.stop()
  })

  it('downloads to a temporary file, verifies the hash and keeps nothing on mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-models-'))
    server.on('GET', '/good.onnx', (_r, res) => {
      res.writeHead(200, { 'content-length': String(bytes.length) })
      res.end(bytes)
    })
    server.on('GET', '/bad.onnx', (_r, res) => {
      res.end(Buffer.from('tampered'))
    })
    const progress: number[] = []
    await downloadModel(
      { file: 'good.onnx', url: `${server.url}/good.onnx`, sha256, bytes: bytes.length },
      join(dir, 'good.onnx'),
      { onProgress: (done) => progress.push(done) },
    )
    expect(await readFile(join(dir, 'good.onnx'))).toEqual(bytes)
    expect(progress.at(-1)).toBe(bytes.length)
    await expect(
      downloadModel(
        { file: 'bad.onnx', url: `${server.url}/bad.onnx`, sha256, bytes: 8 },
        join(dir, 'bad.onnx'),
      ),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    expect(await readdir(dir)).toEqual(['good.onnx'])
    await expect(
      downloadModel(
        { file: 'x.onnx', url: `${server.url}/missing.onnx`, sha256, bytes: 1 },
        join(dir, 'x.onnx'),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('knows where models live and whether they are present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-models-'))
    expect(modelsDir({ RAG_CHUNKER_MODELS_DIR: dir })).toBe(dir)
    expect(modelPath('pp-doclayout-v3', dir)).toBe(join(dir, MODELS['pp-doclayout-v3'].file))
    expect(await hasModel('pp-doclayout-v3', dir)).toBe(false)
    expect(existsSync(modelsDir())).toBeTypeOf('boolean')
  })

  it('picks the detector from the explicit choice, the environment or the profile', () => {
    expect(ocrDetectorModel(undefined, {})).toBe('pp-ocrv5-det')
    expect(ocrDetectorModel(undefined, { RAG_CHUNKER_OCR_DET_MODEL: 'server' })).toBe('pp-ocrv5-det-server')
    expect(ocrDetectorModel('mobile', { RAG_CHUNKER_OCR_DET_MODEL: 'server' })).toBe('pp-ocrv5-det')
    expect(ocrDetectorModel('server', {})).toBe('pp-ocrv5-det-server')
    expect(MODELS['pp-ocrv5-det-server'].bytes).toBeGreaterThan(MODELS['pp-ocrv5-det'].bytes)
    const cfg = (detector: 'auto' | 'mobile' | 'server', profile: 'full' | 'basic') => ({
      ocr: { detector },
      local: { profile },
    })
    expect(resolveOcrDetector(cfg('auto', 'full'), {})).toBe('server')
    expect(resolveOcrDetector(cfg('auto', 'basic'), {})).toBe('mobile')
    expect(resolveOcrDetector(cfg('mobile', 'full'), {})).toBe('mobile')
    expect(resolveOcrDetector(cfg('auto', 'full'), { RAG_CHUNKER_OCR_DET_MODEL: 'mobile' })).toBeUndefined()
  })

  it('plans the recogniser from ocr.script and the profile, and spots CJK text', () => {
    const cfg = (script: 'auto' | 'latin' | 'cjk', profile: 'full' | 'basic') => ({
      ocr: { script },
      local: { profile },
    })
    expect(resolveOcrScript(cfg('auto', 'full'), {})).toEqual({ script: 'auto', cjk: true })
    expect(resolveOcrScript(cfg('auto', 'basic'), {})).toEqual({ script: 'latin', cjk: false })
    expect(resolveOcrScript(cfg('cjk', 'basic'), {})).toEqual({ script: 'cjk', cjk: true })
    expect(resolveOcrScript(cfg('latin', 'full'), {})).toEqual({ script: 'latin', cjk: false })
    expect(resolveOcrScript(cfg('auto', 'full'), { RAG_CHUNKER_OCR_SCRIPT: 'latin' })).toEqual({
      script: 'latin',
      cjk: false,
    })
    expect(cjkShare('中华人民共和国 2024 年')).toBeGreaterThan(0.6)
    expect(cjkShare('日本語のテキスト')).toBe(1)
    expect(cjkShare('Türkiye Cumhuriyeti Anayasası')).toBe(0)
    expect(cjkShare('')).toBe(0)
  })
})
