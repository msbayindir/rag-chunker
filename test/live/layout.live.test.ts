import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PdfDocumentHandle } from '../../src/documents/pdf.js'
import { createLayoutProvider } from '../../src/local/layout.js'
import { hasModel } from '../../src/local/models.js'
import { fixture } from '../fixtures/generate.js'

const ready =
  (await hasModel('pp-doclayout-v3')) &&
  (await import('onnxruntime-node').then(
    () => true,
    () => false,
  ))

describe.skipIf(!ready)('live: PP-DocLayoutV3 layout analysis', () => {
  it('finds the title, text blocks and tables of the fixtures', async () => {
    const layout = await createLayoutProvider()
    const pdf = await PdfDocumentHandle.open(new Uint8Array(await readFile(fixture('tables.pdf'))))
    try {
      const regions = await layout(pdf, 2)
      expect(regions.length).toBeGreaterThan(2)
      expect(regions.some((r) => r.label === 'table')).toBe(true)
      expect(regions.every((r) => r.bbox.x1 > r.bbox.x0 && r.bbox.y1 > r.bbox.y0)).toBe(true)
      const pages = await pdf.textLayer({ layout })
      expect(pages[1]?.spans.some((s) => s.table)).toBe(true)
      expect(pages[1]?.spans.some((s) => s.label)).toBe(true)
    } finally {
      await pdf.close()
    }
  }, 120_000)
})
