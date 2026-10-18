import { describe, expect, it } from 'vitest'
import type { DocumentLayout, LayoutBlock } from '../../src/output/layout.js'
import { assessQuality } from '../../src/output/quality.js'
import type { Chunk } from '../../src/types.js'

const block = (kind: LayoutBlock['kind'], text: string, extra: Partial<LayoutBlock> = {}): LayoutBlock => ({
  id: 'b',
  kind,
  text,
  box: null,
  chunkIds: [],
  ...extra,
})

const chunk = (tokens: number, located = true): Chunk => ({
  chunkId: 'c',
  documentId: 'd',
  source: 's',
  index: 0,
  content: 'x',
  rawContent: 'x',
  contextSummary: '',
  tokenCount: tokens,
  contentType: 'text',
  sectionPath: [],
  pageStart: 1,
  pageEnd: 1,
  ocrSource: 'text-layer',
  boxes: located ? [{ page: 1, x: 0, y: 0, w: 1, h: 0.1 }] : [],
  prevChunkId: null,
  nextChunkId: null,
  mustPreserve: false,
  embedding: [],
})

const ocrStage = {
  engine: 'text-layer',
  model: 'text-layer',
  pages: 3,
  textLayerPages: 2,
  ocrPages: 0,
  cachedPages: 0,
  scannedPages: 1,
  emptyPages: 1,
  headerFooterLinesRemoved: 0,
  layout: null,
  layoutPages: 0,
  durationMs: 1,
}

describe('assessQuality', () => {
  it('counts pages, OCR confidence, garbled text, headings, tables, figures and chunks, and names the findings', () => {
    const layout: DocumentLayout = {
      schemaVersion: 1,
      documentId: 'd',
      source: 's',
      pageCount: 3,
      pages: [
        {
          number: 1,
          width: 595,
          height: 842,
          source: 'text-layer',
          blocks: [
            block('heading', '# Başlık', { level: 1 }),
            block('heading', '### Alt alt başlık', { level: 3 }),
            block('heading', `## ${'uzun '.repeat(30)}`, { level: 2 }),
            block('text', 'Normal bir paragraf; harfler çoğunlukta ve okunabilir.'),
            block('text', '0x1F 2A 3B 4C 5D 6E 7F 8A 9B 10C 11D 12E 13F 14A 15B 16C'),
            block('table', '| a |', {
              table: {
                rows: 2,
                cols: 2,
                headerRows: 1,
                source: 'aligned',
                cells: [
                  { row: 0, col: 0, rowSpan: 1, colSpan: 1, text: 'a' },
                  { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: '' },
                  { row: 1, col: 0, rowSpan: 1, colSpan: 1, text: '' },
                  { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: '' },
                ],
              },
            }),
            block('figure', '![Figure](figures/p1-1.png)', {
              figure: { file: 'figures/p1-1.png', label: 'image' },
            }),
          ],
        },
        {
          number: 2,
          width: 595,
          height: 842,
          source: 'pp-ocr',
          blocks: [
            block('text', 'OCR satırı bir', { confidence: 0.95 }),
            block('text', 'OCR satırı iki', { confidence: 0.4 }),
            block('text', 'OCR satırı üç', { confidence: 0.5 }),
          ],
        },
        { number: 3, width: 595, height: 842, source: 'text-layer', blocks: [] },
      ],
    }
    const chunks = [chunk(300), chunk(600), chunk(20, false)]
    const q = assessQuality({
      layout,
      chunks,
      stages: { ocr: ocrStage },
      chunk: { minTokens: 64, maxTokens: 512 },
      kind: 'pdf',
    })
    expect(q.pages).toEqual({ total: 3, textLayer: 2, ocr: 1, empty: 1 })
    expect(q.ocr).toMatchObject({ blocks: 3, lowConfidenceBlocks: 2 })
    expect(q.ocr?.meanConfidence).toBeCloseTo(0.617, 2)
    expect(q.text.garbledBlocks).toBe(1)
    expect(q.headings).toEqual({ count: 3, maxDepth: 3, long: 1, levelJumps: 1 })
    expect(q.tables).toEqual({ count: 1, bySource: { aligned: 1 }, sparse: 1, continued: 0 })
    expect(q.figures).toEqual({ count: 1, captioned: 0, described: 0 })
    expect(q.chunks).toMatchObject({ count: 3, located: 2, small: 1, large: 1 })
    const joined = q.flags.join('\n')
    for (const expected of [
      '1 page(s) without text',
      'OCR engine',
      '2 of 3 OCR blocks',
      '1 block(s) with few letters',
      '1 table(s) with mostly empty cells',
      '1 heading(s) longer than 120',
      'skip a level 1 time(s)',
      '1 chunk(s) above maxTokens',
      '1 of 1 figure(s) without a caption',
    ])
      expect(joined).toContain(expected)
  })

  it('reports no findings for a clean document', () => {
    const layout: DocumentLayout = {
      schemaVersion: 1,
      documentId: 'd',
      source: 's',
      pageCount: 1,
      pages: [
        {
          number: 1,
          width: null,
          height: null,
          source: 'markdown',
          blocks: [block('heading', '# Başlık', { level: 1 }), block('text', 'Düzgün bir paragraf metni.')],
        },
      ],
    }
    const q = assessQuality({
      layout,
      chunks: [chunk(100, false)],
      stages: { ocr: { ...ocrStage, pages: 1, textLayerPages: 0, scannedPages: 0, emptyPages: 0 } },
      chunk: { minTokens: 64, maxTokens: 512 },
      kind: 'markdown',
    })
    expect(q.flags).toEqual([])
    expect(q.ocr).toBeNull()
    expect(q.pages.empty).toBe(0)
  })
})
