import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseDetections, selectDetections, toRegions } from '../../src/local/layout.js'
import { downloadModel, hasModel, MODELS, modelPath, modelsDir } from '../../src/local/models.js'
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
})
