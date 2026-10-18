import { describe, expect, it } from 'vitest'
import { locateChunk, locateKey, matchSpans, type TextSpan, unionBoxes } from '../../src/documents/layout.js'
import { chunkMarkdown } from '../../src/index.js'
import { buildDocumentLayout } from '../../src/output/layout.js'

const span = (text: string, y: number, x = 0.1, w = 0.8): TextSpan => ({ text, box: { x, y, w, h: 0.02 } })

describe('text location', () => {
  it('normalises away markdown, hyphenation and whitespace', () => {
    expect(locateKey('## 1. Hipo-\nnatremi  *tedavisi*')).toBe('1hiponatremitedavisi')
    expect(locateKey('İSTANBUL')).toBe(locateKey('istanbul'))
  })

  it('unions boxes and clamps to the page', () => {
    expect(unionBoxes([])).toBeNull()
    expect(
      unionBoxes([
        { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
        { x: 0.2, y: 0.5, w: 0.9, h: 0.1 },
      ]),
    ).toEqual({ x: 0.1, y: 0.2, w: 0.9, h: 0.4 })
  })

  it('matches whole spans, split paragraphs and nothing for unrelated text', () => {
    const long = `Sodyum ${'konsantrasyonu düzenli olarak ölçülür ve kaydedilir. '.repeat(8)}`
    const spans = [
      span('## Hiponatremi', 0.1),
      span(long, 0.2),
      span('12', 0.9),
      span('Potasyum ayrı anlatılır.', 0.5),
    ]
    // A chunk holding the heading and the start of the paragraph.
    const start = `## Hiponatremi\n\n${long.slice(0, 120)}`
    expect(matchSpans(start, spans).map((s) => s.box.y)).toEqual([0.1, 0.2])
    // A chunk cut from the middle of the paragraph.
    expect(matchSpans(long.slice(100, 260), spans).map((s) => s.box.y)).toEqual([0.2])
    // The short page number only matches as a whole line, never inside other numbers.
    expect(matchSpans('12', spans).map((s) => s.box.y)).toEqual([0.9])
    expect(matchSpans('Potasyum ayrı anlatılır.\n\n12', spans).map((s) => s.box.y)).toEqual([0.9, 0.5])
    expect(matchSpans('Yıl 2012 raporu', spans)).toEqual([])
    expect(matchSpans('Bambaşka bir metin burada.', spans)).toEqual([])
  })

  it('locates chunks page by page', () => {
    const spans = new Map([
      [1, [span('Birinci sayfa paragrafı burada.', 0.3)]],
      [2, [span('İkinci sayfa paragrafı burada.', 0.4)]],
    ])
    const boxes = locateChunk(
      {
        rawContent: 'Birinci sayfa paragrafı burada.\n\nİkinci sayfa paragrafı burada.',
        pageStart: 1,
        pageEnd: 2,
      },
      spans,
    )
    expect(boxes).toEqual([
      { page: 1, x: 0.1, y: 0.3, w: 0.8, h: 0.02 },
      { page: 2, x: 0.1, y: 0.4, w: 0.8, h: 0.02 },
    ])
    expect(locateChunk({ rawContent: 'x', pageStart: 3, pageEnd: 3 }, spans)).toEqual([])
  })
})

describe('buildDocumentLayout', () => {
  it('lists every block with its page, box and chunks', () => {
    const markdown =
      '<!-- page 1 -->\n\n# Başlık\n\nİlk paragraf metni burada.\n\n<!-- page 2 -->\n\n- bir\n- iki\n\nSon paragraf.'
    const chunks = chunkMarkdown(markdown, { maxTokens: 64, minTokens: 0 })
    const layout = buildDocumentLayout({
      documentId: 'doc',
      source: 'x.pdf',
      markdown,
      pages: [
        {
          pageNumber: 1,
          markdown: '',
          source: 'text-layer',
          width: 595,
          height: 842,
          spans: [span('# Başlık', 0.05), span('İlk paragraf metni burada.', 0.1)],
        },
        { pageNumber: 2, markdown: '', source: 'mistral', width: 595, height: 842 },
      ],
      chunks,
    })
    expect(layout).toMatchObject({ schemaVersion: 1, documentId: 'doc', pageCount: 2 })
    const [p1, p2] = layout.pages
    expect(p1?.blocks.map((b) => [b.id, b.kind, b.level ?? null, b.box?.y ?? null])).toEqual([
      ['p1-b0', 'heading', 1, 0.05],
      ['p1-b1', 'text', null, 0.1],
    ])
    expect(p2?.source).toBe('mistral')
    expect(p2?.blocks.map((b) => [b.kind, b.box])).toEqual([
      ['list', null],
      ['text', null],
    ])
    for (const b of [...(p1?.blocks ?? []), ...(p2?.blocks ?? [])]) {
      expect(b.chunkIds.length).toBeGreaterThan(0)
      for (const id of b.chunkIds) expect(chunks.some((c) => c.chunkId === id)).toBe(true)
    }
  })
})
