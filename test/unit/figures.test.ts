import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../../src/chunker/markdown.js'
import {
  altText,
  CAPTION_RE,
  captionFor,
  type FigureData,
  figureCandidates,
  mergeImageRects,
} from '../../src/documents/figures.js'
import { PdfDocumentHandle } from '../../src/documents/pdf.js'
import { extractRulings, type Rect } from '../../src/documents/tables.js'
import type { LayoutRegion } from '../../src/local/layout.js'
import { FIGURES } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'

const bytes = async (name: string) => new Uint8Array(await readFile(fixture(name)))
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol
const page = { width: 595, height: 842 }
const region = (label: LayoutRegion['label'], bbox: Rect, score = 0.9, order = 0): LayoutRegion => ({
  label,
  score,
  bbox,
  order,
})
const line = (text: string, x0: number, y: number, x1?: number, size = 10) => ({
  text,
  x0,
  x1: x1 ?? x0 + text.length * 5,
  y,
  size,
})

describe('figure candidates', () => {
  it('merges touching image strips and keeps separate pictures apart', () => {
    const merged = mergeImageRects([
      { x0: 56, x1: 356, y0: 600, y1: 660 },
      { x0: 56, x1: 356, y0: 540, y1: 600 },
      { x0: 400, x1: 500, y0: 100, y1: 200 },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ x0: 56, x1: 356, y0: 540, y1: 660 })
  })

  it('takes layout image/chart regions once, drops icons, full pages, pictures under text and in other regions', () => {
    const regions = [
      region('image', { x0: 50, x1: 300, y0: 500, y1: 700 }, 0.8, 2),
      region('chart', { x0: 52, x1: 302, y0: 498, y1: 702 }, 0.95, 2),
      region('text', { x0: 50, x1: 545, y0: 100, y1: 400 }, 0.9, 3),
    ]
    const out = figureCandidates({
      lines: [],
      regions,
      images: [
        { x0: 60, x1: 290, y0: 510, y1: 690 }, // the same picture as a raster: covered
        { x0: 100, x1: 400, y0: 150, y1: 350 }, // inside the text region: background
        { x0: 500, x1: 530, y0: 800, y1: 830 }, // a logo
        { x0: 0, x1: 595, y0: 0, y1: 842 }, // a scanned page
        { x0: 350, x1: 550, y0: 500, y1: 700 }, // a picture the model missed
      ],
      page,
      minSize: 0.015,
    })
    expect(out.map((c) => [c.label, c.score, c.bbox.x0])).toEqual([
      ['chart', 0.95, 52],
      ['image', 1, 350],
    ])
    expect(out[0]?.order).toBe(2)
  })

  it('leaves out a picture with paragraph text written over it (watermark)', () => {
    const lines = Array.from({ length: 7 }, (_, i) => line('x'.repeat(90), 56, 680 - i * 14, 530))
    const out = figureCandidates({
      lines,
      regions: null,
      images: [{ x0: 56, x1: 536, y0: 400, y1: 700 }],
      page,
      minSize: 0.015,
    })
    expect(out).toHaveLength(0)
    const few = figureCandidates({
      lines: lines.slice(0, 3),
      regions: null,
      images: [{ x0: 56, x1: 536, y0: 400, y1: 700 }],
      page,
      minSize: 0.015,
    })
    expect(few).toHaveLength(1)
  })

  it('recognises caption starts in several languages', () => {
    for (const ok of [
      'Figure 3: x',
      'Fig. 2a. y',
      'Şekil 1',
      'Grafik 12 –',
      'Abbildung 4',
      'Figura 2',
      'FIGURE IV',
      'Chart: z',
    ])
      expect(CAPTION_RE.test(ok), ok).toBe(true)
    for (const no of ['Figures are shown below', 'Image quality matters', 'Şekilsiz', 'The figure 3 shows'])
      expect(CAPTION_RE.test(no), no).toBe(false)
  })

  it('finds the caption below (with its continuation), above, or in a figure_title region', () => {
    const fig = { x0: 56, x1: 356, y0: 420, y1: 620 }
    const lines = [
      line('Başlık metni', 56, 700),
      line('Şekil 1: Elektrolit dengesi', 56, 402),
      line('(kaynak: rehber)', 56, 388),
      line('Sonraki paragraf başlıyor ve devam ediyor.', 56, 350),
    ]
    expect(captionFor(fig, lines, null)?.text).toBe('Şekil 1: Elektrolit dengesi (kaynak: rehber)')
    const hyphenated = [
      line('Figure 7: Overall pre-training and fine-tuning proce-', 56, 402),
      line('dures for BERT.', 56, 390),
    ]
    expect(captionFor(fig, hyphenated, null)?.text).toBe(
      'Figure 7: Overall pre-training and fine-tuning procedures for BERT.',
    )
    const above = [line('Figure 2. Above the picture', 56, 630), line('Body text far below.', 56, 300)]
    expect(captionFor(fig, above, null)?.text).toBe('Figure 2. Above the picture')
    expect(captionFor(fig, [line('No caption here', 56, 402)], null)).toBeNull()
    const regions = [region('figure_title', { x0: 50, x1: 360, y0: 380, y1: 412 }, 0.9, 5)]
    const titled = captionFor(fig, [line('Any wording works in a title region', 56, 402)], regions)
    expect(titled?.text).toBe('Any wording works in a title region')
    expect(altText(titled?.text, 'image')).toBe('Any wording works in a title region')
    expect(altText(undefined, 'chart')).toBe('Chart')
    expect(altText('a [b] c', 'image')).toBe('a b c')
  })

  it('marks an image-only paragraph as a figure block', () => {
    const { blocks } = parseBlocks('# T\n\n![Şekil 1](figures/p1-1.png)\n\nMetin ![inline](x.png) devam.', 2)
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'figure', 'text'])
  })
})

describe('figures from a PDF', () => {
  it('reads image rectangles from the content stream', async () => {
    const handle = await PdfDocumentHandle.open(await bytes('figures.pdf'))
    const proxy = (
      handle as unknown as { proxy: { getPage(n: number): Promise<Parameters<typeof extractRulings>[0]> } }
    ).proxy
    const p1 = await extractRulings(await proxy.getPage(1))
    const rects = (p1.images ?? []).map((r) => [r.x0, r.y0, r.x1, r.y1].map(Math.round))
    expect(rects).toContainEqual([56, 420, 356, 620])
    expect(rects).toContainEqual([500, 790, 530, 820])
    const p2 = await extractRulings(await proxy.getPage(2))
    expect(p2.images).toHaveLength(2)
    await handle.close()
  })

  it('reports captioned figures to the sink and places them in the page flow', async () => {
    const handle = await PdfDocumentHandle.open(await bytes('figures.pdf'))
    const calls: Array<{ page: number; bbox: Rect; caption?: string }> = []
    const pages = await handle.textLayer({
      figures: {
        save: async (_doc, pageNumber, f) => {
          calls.push({ page: pageNumber, bbox: f.bbox, caption: f.caption })
          const data: FigureData = { file: `figures/p${pageNumber}-${calls.length}.png`, label: f.label }
          if (f.caption) data.caption = f.caption
          if (pageNumber === 2) data.description = 'Two strips of one scheme.'
          return data
        },
      },
    })
    await handle.close()
    expect(calls.map((c) => c.page)).toEqual([1, 2])
    const first = calls[0] as (typeof calls)[number]
    expect(
      near(first.bbox.x0, 56) &&
        near(first.bbox.y0, 420) &&
        near(first.bbox.x1, 356) &&
        near(first.bbox.y1, 620),
    ).toBe(true)
    expect(first.caption).toBe(`${FIGURES.caption1} ${FIGURES.caption1b}`)
    const second = calls[1] as (typeof calls)[number]
    expect(near(second.bbox.y0, 620) && near(second.bbox.y1, 740)).toBe(true)
    expect(second.caption).toBe(FIGURES.caption2)

    const md1 = pages[0]?.markdown ?? ''
    const ref = `![${FIGURES.caption1} ${FIGURES.caption1b}](figures/p1-1.png)`
    expect(md1).toContain(ref)
    // The image comes after the intro and before its caption; the caption text stays in the flow.
    expect(md1.indexOf(FIGURES.intro.slice(0, 20))).toBeLessThan(md1.indexOf(ref))
    expect(md1.indexOf(ref)).toBeLessThan(md1.indexOf(FIGURES.caption1))
    expect(md1).not.toContain('p1-2.png')
    const span = pages[0]?.spans.find((s) => s.figure)
    expect(span?.figure).toMatchObject({ file: 'figures/p1-1.png', label: 'image', caption: first.caption })
    expect(span?.box.y).toBeGreaterThan(0.2)
    const md2 = pages[1]?.markdown ?? ''
    expect(md2).toContain(`![${FIGURES.caption2}](figures/p2-2.png)\n\nTwo strips of one scheme.`)
    expect(md2.indexOf(FIGURES.caption2)).toBeLessThan(md2.indexOf('figures/p2-2.png'))
    // The watermark page has text over the picture: no figure.
    expect(pages[2]?.markdown ?? '').not.toContain('figures/')
  })
})
