import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { docxToMarkdown } from '../../src/documents/docx.js'
import { detectKind, readDocument } from '../../src/documents/input.js'
import { PdfDocumentHandle, type PdfTextPage, planPageBatches, subsetPdf } from '../../src/documents/pdf.js'
import { pptxToMarkdown } from '../../src/documents/pptx.js'
import type { TableData } from '../../src/documents/tables.js'
import { RagChunkerError } from '../../src/errors.js'
import { teds } from '../../src/eval/teds.js'
import type { LayoutLabel, PageLayoutProvider } from '../../src/local/layout.js'
import {
  cleanPageMarkdown,
  joinPages,
  removeRepeatedHeaderFooter,
  splitPages,
  stripImages,
  unwrapMarkdownFence,
} from '../../src/ocr/postprocess.js'
import {
  DOCX,
  HEADER,
  PAGE1,
  PAGE2,
  PAGE3,
  PPTX,
  SIDE_BY_SIDE,
  TABLES,
  TWO_COLUMN,
} from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'

const bytes = async (name: string) => new Uint8Array(await readFile(fixture(name)))

describe('input detection', () => {
  it('detects kinds from magic bytes and extensions', async () => {
    expect(detectKind(await bytes('turkish.pdf'), 'x.bin').kind).toBe('pdf')
    expect(detectKind(await bytes('scan.png'), 'x').mime).toBe('image/png')
    expect(detectKind(await bytes('sample.docx'), 'a').kind).toBe('docx')
    expect(detectKind(await bytes('sample.pptx'), 'a').kind).toBe('pptx')
    expect(detectKind(new TextEncoder().encode('# Merhaba'), 'notes.md').kind).toBe('markdown')
    expect(detectKind(new TextEncoder().encode('düz metin'), 'notes').kind).toBe('markdown')
    expect(() => detectKind(new Uint8Array([0, 1, 2, 3, 0, 0]), 'blob.bin')).toThrow(RagChunkerError)
    expect(() => detectKind(new TextEncoder().encode('not a zip'), 'fake.docx')).toThrow(/valid .docx/)
  })

  it('reads files and rejects missing or empty input', async () => {
    const doc = await readDocument(fixture('sample.md'))
    expect(doc).toMatchObject({ kind: 'markdown', name: 'sample.md' })
    expect(doc.documentId).toMatch(/^[0-9a-f]{64}$/)
    await expect(readDocument(fixture('nope.pdf'))).rejects.toThrow(/not found/)
    await expect(readDocument(new Uint8Array(), 'x.md')).rejects.toThrow(/empty/)
  })
})

describe('PDF text layer', () => {
  it('turns font sizes into headings, keeps lists and joins hyphenated words', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('turkish.pdf'))
    try {
      expect(pdf.pageCount).toBe(4)
      const pages = await pdf.textLayer()
      const p1 = pages[0]?.markdown ?? ''
      expect(p1).toContain(`# ${PAGE1.title}`)
      expect(p1).toContain(`## ${PAGE1.heading}`)
      expect(p1).toContain(PAGE1.paragraphs[0])
      const p2 = pages[1]?.markdown ?? ''
      expect(p2).toContain(`### ${PAGE2.heading}`)
      for (const b of PAGE2.bullets) expect(p2).toContain(`- ${b}`)
      expect(p2).toContain('konsantrasyonun düzeltilmesi')
      expect(pages[2]?.markdown).toContain(`## ${PAGE3.heading}`)
      // Page 4 is an image: no text layer.
      expect(pages[3]?.chars).toBe(0)
      expect(pages.every((p) => !p.garbled)).toBe(true)
      // Every block carries its position; the title sits above the first paragraph.
      const page = pages[0]
      expect(page?.width).toBeGreaterThan(0)
      expect(page?.height).toBeGreaterThan(page?.width as number)
      const spans = page?.spans ?? []
      expect(spans.length).toBeGreaterThan(2)
      const title = spans.find((s) => s.text === `# ${PAGE1.title}`)
      const para = spans.find((s) => s.text.startsWith(PAGE1.paragraphs[0]?.slice(0, 30) as string))
      expect(title?.box.y).toBeLessThan(para?.box.y as number)
      for (const s of spans) {
        for (const v of [s.box.x, s.box.y, s.box.w, s.box.h]) expect(v).toBeGreaterThanOrEqual(0)
        expect(s.box.x + s.box.w).toBeLessThanOrEqual(1.0001)
        expect(s.box.y + s.box.h).toBeLessThanOrEqual(1.0001)
      }
      // List items are separate spans so chunks can be located item by item.
      expect(pages[1]?.spans.filter((s) => s.text.startsWith('- ')).length).toBe(PAGE2.bullets.length)
    } finally {
      await pdf.close()
    }
  })

  it('reads two-column pages column by column', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('two-column.pdf'))
    const page = (await pdf.textLayer())[0]
    const md = page?.markdown ?? ''
    await pdf.close()
    const lastLeft = md.lastIndexOf(TWO_COLUMN.left[1] as string)
    const firstRight = md.indexOf(TWO_COLUMN.right[0] as string)
    expect(lastLeft).toBeGreaterThan(-1)
    expect(firstRight).toBeGreaterThan(lastLeft)
    expect(md).not.toMatch(/fizyolojisini Sağ/)
    // Boxes follow the columns.
    for (const s of page?.spans ?? []) {
      if (s.text.startsWith('Sol')) expect(s.box.x + s.box.w).toBeLessThan(0.5)
      if (s.text.startsWith('Sağ')) expect(s.box.x).toBeGreaterThan(0.5)
    }
  })

  it('reads side-by-side blocks on single-column pages one block at a time', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('side-by-side.pdf'))
    const md = (await pdf.textLayer())[0]?.markdown ?? ''
    await pdf.close()
    const order = [SIDE_BY_SIDE.intro, SIDE_BY_SIDE.left, SIDE_BY_SIDE.right, SIDE_BY_SIDE.outro]
    const at = order.map((text) => md.indexOf(text))
    expect(at.every((i) => i > -1)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it('reads ruled, rule-bounded, aligned and continued tables from the text layer', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('tables.pdf'))
    const pages = await pdf.textLayer()
    await pdf.close()
    const tablesOf = (n: number) => (pages[n]?.spans ?? []).flatMap((s) => (s.table ? [s] : []))
    const plain = (rows: string[][], headerRows: number, source: TableData['source']): TableData => ({
      rows: rows.length,
      cols: rows[0]?.length ?? 0,
      headerRows,
      source,
      cells: rows.flatMap((r, row) => r.map((text, col) => ({ row, col, rowSpan: 1, colSpan: 1, text }))),
    })

    // Page 1: a grid with a two-row header (row spans + a column span), then a booktabs-style table.
    const [ruled, rules] = tablesOf(0)
    const ruledGold: TableData = {
      rows: 6,
      cols: 4,
      headerRows: 2,
      source: 'ruled',
      cells: [
        { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: 'Parametre' },
        { row: 0, col: 1, rowSpan: 2, colSpan: 1, text: 'Birim' },
        { row: 0, col: 2, rowSpan: 1, colSpan: 2, text: 'Referans aralığı' },
        { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: 'Alt sınır' },
        { row: 1, col: 3, rowSpan: 1, colSpan: 1, text: 'Üst sınır' },
        ...TABLES.ruled.rows.flatMap((r, i) =>
          r.map((text, col) => ({ row: i + 2, col, rowSpan: 1, colSpan: 1, text })),
        ),
      ],
    }
    expect(ruled?.table).toMatchObject({ rows: 6, cols: 4, headerRows: 2, source: 'ruled' })
    expect(teds(ruled?.table as TableData, ruledGold)).toBeGreaterThanOrEqual(0.98)
    expect(ruled?.text.split('\n')[0]).toBe('| Parametre | Birim | Referans aralığı Alt sınır | Üst sınır |')
    expect(ruled?.text).toContain('| İyonize kalsiyum | mmol/L | 1,12 | 1,32 |')
    expect(rules?.table).toMatchObject({ rows: 4, cols: 3, headerRows: 1, source: 'rules' })
    expect(
      teds(rules?.table as TableData, plain([TABLES.rules.header, ...TABLES.rules.rows], 1, 'rules')),
    ).toBe(1)
    // Captions and the paragraph in between stay ordinary text, in order.
    const md1 = pages[0]?.markdown ?? ''
    expect(md1.indexOf(TABLES.caption1)).toBeLessThan(md1.indexOf('| Parametre'))
    expect(md1.indexOf(TABLES.afterRuled.slice(0, 30))).toBeGreaterThan(md1.indexOf('| İyonize'))
    expect(md1.indexOf(TABLES.caption3)).toBeLessThan(md1.indexOf('| Ad |'))

    // Page 2: an aligned table without any line, then a grid that runs off the page.
    const [aligned, firstPart] = tablesOf(1)
    expect(aligned?.table).toMatchObject({ rows: 6, cols: 3, source: 'aligned' })
    expect(
      teds(aligned?.table as TableData, plain([TABLES.aligned.header, ...TABLES.aligned.rows], 1, 'aligned')),
    ).toBe(1)
    expect(firstPart?.table).toMatchObject({ rows: 6, cols: 3, source: 'ruled' })

    // Page 3: the continuation gets the header of the table it continues.
    const [cont] = tablesOf(2)
    expect(cont?.table?.continuation).toBe(true)
    expect(pages[2]?.markdown.startsWith('| İlaç | Doz | Sıklık |')).toBe(true)
    expect(
      teds(
        cont?.table as TableData,
        plain([TABLES.continued.header, ...TABLES.continued.secondPage], 1, 'ruled'),
      ),
    ).toBe(1)
    expect(pages[2]?.markdown).toContain(TABLES.afterContinued.slice(0, 30))
    // Nothing is lost: every cell text of every table is in the page markdown.
    for (const [n, t] of [
      [0, TABLES.ruled.rows],
      [1, TABLES.aligned.rows],
      [2, TABLES.continued.secondPage],
    ] as const) {
      for (const text of t.flat()) expect(pages[n]?.markdown).toContain(text)
    }
  })

  it('follows a layout provider: drops figure text, promotes titles, orders regions and gates line-less tables', async () => {
    const open = async (name: string) => PdfDocumentHandle.open(await bytes(name))
    // Regions are built from the page's own spans so the test does not depend on fixture geometry.
    const regionOf = (
      page: PdfTextPage,
      pick: (text: string) => boolean,
      label: LayoutLabel,
      order: number,
      score = 0.9,
    ) => {
      const spans = page.spans.filter((s) => pick(s.text))
      expect(spans.length).toBeGreaterThan(0)
      const x0 = Math.min(...spans.map((s) => s.box.x)) * page.width
      const x1 = Math.max(...spans.map((s) => s.box.x + s.box.w)) * page.width
      const top = Math.min(...spans.map((s) => s.box.y))
      const bottom = Math.max(...spans.map((s) => s.box.y + s.box.h))
      return {
        label,
        score,
        order,
        bbox: { x0, x1, y0: page.height - bottom * page.height, y1: page.height - top * page.height },
      }
    }

    let pdf = await open('turkish.pdf')
    const plain = await pdf.textLayer()
    await pdf.close()
    const [p1, p2, p3] = plain as [PdfTextPage, PdfTextPage, PdfTextPage]
    const firstLine = PAGE2.paragraph.slice(0, 20)
    const layout: PageLayoutProvider = async (_doc, n) => {
      if (n === 2) {
        return [
          regionOf(p2, (t) => t.startsWith(`### ${PAGE2.heading}`), 'paragraph_title', 0),
          regionOf(p2, (t) => t.startsWith(firstLine), 'text', 1),
          // The bullets are "inside a figure": their text disappears.
          regionOf(p2, (t) => t.startsWith('- '), 'image', 2),
          regionOf(
            p2,
            (t) => /\p{L}/u.test(t) && !t.startsWith('-') && !t.startsWith('#') && !t.startsWith(firstLine),
            'text',
            3,
          ),
        ]
      }
      if (n === 3) {
        // Reading order from the model wins: the second paragraph comes first.
        const paras = p3.spans.filter((s) => !s.text.startsWith('#'))
        return [
          regionOf(p3, (t) => t === paras[0]?.text, 'text', 5),
          regionOf(p3, (t) => t === paras[1]?.text, 'text', 1),
          regionOf(p3, (t) => t.startsWith('#'), 'paragraph_title', 0),
        ]
      }
      return [regionOf(p1, () => true, 'text', 0, 0.55)]
    }
    pdf = await open('turkish.pdf')
    const pages = await pdf.textLayer({ layout })
    await pdf.close()
    const md2 = pages[1]?.markdown ?? ''
    expect(md2).toContain(`### ${PAGE2.heading}`)
    for (const b of PAGE2.bullets) expect(md2).not.toContain(b)
    expect(pages[1]?.spans.find((s) => s.text.startsWith('###'))?.label).toBe('paragraph_title')
    const md3 = pages[2]?.markdown ?? ''
    const [a, b] = p3.spans.filter((s) => !s.text.startsWith('#')).map((s) => s.text)
    expect(md3.indexOf(b as string)).toBeLessThan(md3.indexOf(a as string))
    // A confident "text" region keeps the title from being a heading; page 1's low score does not.
    expect(pages[0]?.markdown).toContain(`# ${PAGE1.title}`)

    // Line-less tables need a table region when a layout is available.
    pdf = await open('tables.pdf')
    const bare = await pdf.textLayer()
    await pdf.close()
    const page2 = bare[1] as PdfTextPage
    const aligned = page2.spans.find((s) => s.table?.source === 'aligned') as (typeof page2.spans)[number]
    const tableRegion = regionOf(page2, (t) => t === aligned.text, 'table', 1)
    const everything = regionOf(page2, () => true, 'text', 0)
    pdf = await open('tables.pdf')
    const withHint = await pdf.textLayer({
      layout: async (_d, n) => (n === 2 ? [tableRegion, everything] : []),
    })
    const withoutHint = await pdf.textLayer({ layout: async (_d, n) => (n === 2 ? [everything] : []) })
    await pdf.close()
    expect(withHint[1]?.spans.filter((s) => s.table?.source === 'aligned')).toHaveLength(1)
    expect(withoutHint[1]?.spans.filter((s) => s.table?.source === 'aligned')).toHaveLength(0)
    expect(withoutHint[1]?.markdown).toContain(TABLES.aligned.rows[0]?.[1] as string)
  })

  it('reads scanned pages through an OCR provider and builds the same page structure', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('turkish.pdf'))
    const seen: number[] = []
    const pages = await pdf.textLayer({
      ocr: {
        needed: (p) => p.chars < 40,
        recognize: async (_doc, n) => {
          seen.push(n)
          return {
            width: 1000,
            height: 1400,
            lines: [
              { text: '3. Hipokalsemi', x0: 100, y0: 100, x1: 420, y1: 140, confidence: 0.98 },
              {
                text: 'Hipokalsemi tetani ve kas krampları ile',
                x0: 100,
                y0: 180,
                x1: 800,
                y1: 204,
                confidence: 0.91,
              },
              { text: 'kendini gösterir.', x0: 100, y0: 212, x1: 420, y1: 236, confidence: 0.6 },
            ],
          }
        },
      },
    })
    await pdf.close()
    expect(seen).toEqual([4])
    const p4 = pages[3] as PdfTextPage
    expect(p4).toMatchObject({ source: 'ocr', scanned: true })
    expect(pages[0]?.source).toBe('text-layer')
    expect(p4.markdown).toBe('# 3. Hipokalsemi\n\nHipokalsemi tetani ve kas krampları ile kendini gösterir.')
    const para = p4.spans.find((s) => s.text.startsWith('Hipokalsemi tetani'))
    expect(para?.confidence).toBe(0.6)
    expect(para?.box.y).toBeGreaterThan(p4.spans[0]?.box.y as number)
  })

  it('renders pages to PNG and builds page subsets', async () => {
    const pdfBytes = await bytes('turkish.pdf')
    const pdf = await PdfDocumentHandle.open(pdfBytes)
    const png = await pdf.renderPng(1, 600)
    await pdf.close()
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const subset = await subsetPdf(pdfBytes, [3, 1])
    const sub = await PdfDocumentHandle.open(subset)
    expect(sub.pageCount).toBe(2)
    expect((await sub.textLayer())[0]?.markdown).toContain(PAGE3.heading)
    await sub.close()
  })

  it('plans OCR batches within byte and page limits', () => {
    expect(planPageBatches([1, 2, 3, 4, 5], 100, 5, 40, 500)).toEqual([[1, 2], [3, 4], [5]])
    expect(planPageBatches([1, 2, 3], 10, 3, 1000, 2)).toEqual([[1, 2], [3]])
  })

  it('reports invalid PDFs clearly', async () => {
    await expect(PdfDocumentHandle.open(new TextEncoder().encode('%PDF-1.7 broken'))).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    })
  })
})

describe('Office documents', () => {
  it('converts DOCX headings, paragraphs and tables', async () => {
    const { markdown } = await docxToMarkdown(await bytes('sample.docx'))
    expect(markdown).toContain(`# ${DOCX.h1}`)
    expect(markdown).toContain(`## ${DOCX.h2}`)
    expect(markdown).toContain(DOCX.p2)
    expect(markdown).toMatch(/\| Parametre\s*\| Normal Değer\s*\|/)
    expect(markdown).toMatch(/\| GFR\s*\| 90-120 mL\/dk\s*\|/)
    expect(markdown).not.toContain('<table')
  })

  it('converts PPTX slides into pages with titles, nested bullets, tables and notes', async () => {
    const { markdown, slideCount } = await pptxToMarkdown(await bytes('sample.pptx'))
    expect(slideCount).toBe(2)
    const pages = splitPages(markdown)
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2])
    expect(pages[0]?.markdown).toContain(`## ${PPTX.slide1.title}`)
    expect(pages[0]?.markdown).toContain('- Total vücut suyu\n  - Hücre içi sıvı')
    expect(pages[0]?.markdown).toContain(`Notes: ${PPTX.slide1.notes}`)
    expect(pages[1]?.markdown).toContain('| Sodyum | 135-145 |')
  })

  it('rejects broken Office files', async () => {
    await expect(docxToMarkdown(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    await expect(pptxToMarkdown(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'INPUT_INVALID' })
  })
})

describe('OCR post-processing', () => {
  it('removes repeated headers and page-number footers', () => {
    const bodies = ['Sodyum dengesi.', 'Potasyum dengesi.', 'Kalsiyum dengesi.', 'Magnezyum dengesi.']
    const pages = [1, 2, 3, 4].map((n) => `${HEADER}\n\n# Bölüm ${n}\n\n${bodies[n - 1]}\n\nSayfa ${n + 10}`)
    const { pages: out, removed } = removeRepeatedHeaderFooter(pages)
    expect(removed).toBe(8)
    for (const [i, p] of out.entries()) {
      expect(p).not.toContain(HEADER)
      expect(p).not.toMatch(/Sayfa \d/)
      expect(p).toContain(`# Bölüm ${i + 1}`)
    }
    expect(removeRepeatedHeaderFooter(pages.slice(0, 2)).removed).toBe(0)
    // A table header repeated at the top of every page is part of the table, not a running header.
    const texts = ['Birinci sayfanın metni.', 'İkinci sayfanın metni.', 'Üçüncü sayfanın metni.']
    const tablePages = texts.map((b, n) => `| İlaç | Doz |\n| --- | --- |\n| ilaç ${n} | ${n} mg |\n\n${b}`)
    expect(removeRepeatedHeaderFooter(tablePages)).toEqual({ pages: tablePages, removed: 0 })
  })

  it('does not remove lines that only repeat on a few pages', () => {
    const pages = ['A\n\nbir', 'A\n\niki', 'B\n\nüç', 'C\n\ndört', 'D\n\nbeş', 'E\n\naltı', 'F\n\nyedi']
    expect(removeRepeatedHeaderFooter(pages).removed).toBe(0)
    // Numbered headings at the top of each page are content, not page numbers.
    const chapters = ['bir', 'iki', 'üç', 'dört'].map((w, i) => `# Bölüm ${i + 1}\n\n${w} metni`)
    expect(removeRepeatedHeaderFooter(chapters).removed).toBe(0)
  })

  it('cleans OCR output', () => {
    expect(stripImages('Metin\n\n![img-0.jpeg](img-0.jpeg)\n\nDevam')).toBe('Metin\n\nDevam')
    expect(unwrapMarkdownFence('```markdown\n# Başlık\n```')).toBe('# Başlık')
    expect(cleanPageMarkdown('<!-- page 9 -->\n# A   \n\n\n\nB', { stripImages: true })).toBe('# A\n\nB')
  })

  it('round-trips page markers', () => {
    const md = joinPages([
      { pageNumber: 1, markdown: 'bir' },
      { pageNumber: 2, markdown: 'iki' },
    ])
    expect(md).toBe('<!-- page 1 -->\n\nbir\n\n<!-- page 2 -->\n\niki')
    expect(splitPages(md)).toEqual([
      { pageNumber: 1, markdown: 'bir' },
      { pageNumber: 2, markdown: 'iki' },
    ])
    expect(splitPages('giriş\n\n<!-- page 2 -->\n\niki')).toEqual([
      { pageNumber: 1, markdown: 'giriş' },
      { pageNumber: 2, markdown: 'iki' },
    ])
    expect(splitPages('sadece metin')).toEqual([{ pageNumber: 1, markdown: 'sadece metin' }])
  })
})
