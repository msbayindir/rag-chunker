import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PdfDocumentHandle } from '../../src/documents/pdf.js'
import type { TableData } from '../../src/documents/tables.js'
import { teds } from '../../src/eval/teds.js'
import { hasModel } from '../../src/local/models.js'
import { createTableStructureProvider } from '../../src/local/table.js'
import { TABLES } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'

const ready =
  (await Promise.all((['slanet-plus', 'slanet-dict'] as const).map((id) => hasModel(id)))).every(Boolean) &&
  (await import('onnxruntime-node').then(
    () => true,
    () => false,
  ))

describe.skipIf(!ready)('live: SLANet_plus table structure', () => {
  it('recovers the grid of the ruled fixture table, spans included', async () => {
    const recognize = await createTableStructureProvider()
    const pdf = await PdfDocumentHandle.open(new Uint8Array(await readFile(fixture('tables.pdf'))))
    try {
      const page = (await pdf.textLayer())[0]
      const span = page?.spans.find((s) => s.table?.source === 'ruled')
      expect(span).toBeDefined()
      const b = (span as NonNullable<typeof span>).box
      const W = page?.width as number
      const H = page?.height as number
      const region = { x0: b.x * W, x1: (b.x + b.w) * W, y0: H - (b.y + b.h) * H, y1: H - b.y * H }
      const model = await recognize(pdf, 1, region)
      expect(model).not.toBeNull()
      const m = model as NonNullable<typeof model>
      expect(m).toMatchObject({ rows: 6, cols: 4 })
      const gold: TableData = {
        rows: 6,
        cols: 4,
        headerRows: 2,
        source: 'ruled',
        cells: [
          { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: '' },
          { row: 0, col: 1, rowSpan: 2, colSpan: 1, text: '' },
          { row: 0, col: 2, rowSpan: 1, colSpan: 2, text: '' },
          { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: '' },
          { row: 1, col: 3, rowSpan: 1, colSpan: 1, text: '' },
          ...TABLES.ruled.rows.flatMap((r, i) =>
            r.map((_, col) => ({ row: i + 2, col, rowSpan: 1, colSpan: 1, text: '' })),
          ),
        ],
      }
      const predicted: TableData = {
        rows: m.rows,
        cols: m.cols,
        headerRows: 2,
        source: 'model',
        cells: m.cells.map((c) => ({
          row: c.row,
          col: c.col,
          rowSpan: c.rowSpan,
          colSpan: c.colSpan,
          text: '',
        })),
      }
      expect(teds(predicted, gold, { structureOnly: true })).toBeGreaterThanOrEqual(0.9)
    } finally {
      await pdf.close()
    }
  }, 120_000)
})
