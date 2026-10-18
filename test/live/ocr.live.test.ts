import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { processDocument } from '../../src/index.js'
import { hasModel } from '../../src/local/models.js'
import { createOcrProvider } from '../../src/local/ocr.js'
import { SCANNED } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'

const ready =
  (
    await Promise.all(
      (['pp-ocrv5-det', 'pp-ocrv5-rec-latin', 'pp-ocrv5-dict-latin'] as const).map((id) => hasModel(id)),
    )
  ).every(Boolean) &&
  (await import('onnxruntime-node').then(
    () => true,
    () => false,
  ))

describe.skipIf(!ready)('live: PP-OCRv5 local OCR', () => {
  it('reads the scanned fixture image with Turkish characters intact', async () => {
    const ocr = await createOcrProvider()
    const result = await ocr.image(new Uint8Array(await readFile(fixture('scan.png'))))
    const text = result.lines.map((l) => l.text).join(' ')
    expect(text).toContain(SCANNED.heading)
    expect(text).toContain('kas krampları ile kendini gösterir')
    expect(result.lines.every((l) => l.confidence > 0.8)).toBe(true)
  }, 60_000)

  it('OCRs the scanned page of a PDF and the image input end to end', async () => {
    const res = await processDocument(
      fixture('turkish.pdf'),
      { ocr: { engine: 'pp-ocr' }, cache: { enabled: false } },
      { env: {} },
    )
    expect(res.manifest.stages.ocr).toMatchObject({ engine: 'pp-ocr', ocrPages: 1, textLayerPages: 3 })
    expect(res.markdown).toContain(SCANNED.heading)
    const img = await processDocument(
      fixture('scan.png'),
      { ocr: { engine: 'pp-ocr' }, cache: { enabled: false } },
      { env: {} },
    )
    expect(img.markdown).toContain(SCANNED.heading)
    expect(img.chunks[0]?.boxes.length).toBeGreaterThan(0)
  }, 120_000)
})
