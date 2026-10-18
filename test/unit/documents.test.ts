import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { docxToMarkdown } from '../../src/documents/docx.js'
import { detectKind, readDocument } from '../../src/documents/input.js'
import { PdfDocumentHandle, planPageBatches, subsetPdf } from '../../src/documents/pdf.js'
import { pptxToMarkdown } from '../../src/documents/pptx.js'
import { RagChunkerError } from '../../src/errors.js'
import {
  cleanPageMarkdown,
  joinPages,
  removeRepeatedHeaderFooter,
  splitPages,
  stripImages,
  unwrapMarkdownFence,
} from '../../src/ocr/postprocess.js'
import { DOCX, HEADER, PAGE1, PAGE2, PAGE3, PPTX, SIDE_BY_SIDE, TWO_COLUMN } from '../fixtures/content.js'
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
    } finally {
      await pdf.close()
    }
  })

  it('reads two-column pages column by column', async () => {
    const pdf = await PdfDocumentHandle.open(await bytes('two-column.pdf'))
    const md = (await pdf.textLayer())[0]?.markdown ?? ''
    await pdf.close()
    const lastLeft = md.lastIndexOf(TWO_COLUMN.left[1] as string)
    const firstRight = md.indexOf(TWO_COLUMN.right[0] as string)
    expect(lastLeft).toBeGreaterThan(-1)
    expect(firstRight).toBeGreaterThan(lastLeft)
    expect(md).not.toMatch(/fizyolojisini Sağ/)
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
