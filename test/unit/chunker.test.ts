import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { chunkMarkdownDocument } from '../../src/chunker/chunker.js'
import { assignChunkIds, buildContent } from '../../src/chunker/finalize.js'
import { splitToBudget } from '../../src/chunker/split.js'
import { getTokenizer } from '../../src/chunker/tokenizer.js'
import { missingWords, words } from '../helpers/words.js'

const tok = getTokenizer('o200k')
const lorem = (n: number, seed = 0) =>
  Array.from({ length: n }, (_, i) => `kelime${(i + seed) % 97}`).join(' ')
const sentences = (n: number, seed = 0) =>
  Array.from({ length: n }, (_, i) => `Bu ${i + seed}. cümle hiponatremi tedavisini anlatır.`).join(' ')

describe('chunkMarkdownDocument — v3 regressions', () => {
  it('never drops a heading, a short intro or a short tail around an oversized paragraph', () => {
    const md = [
      '<!-- page 1 -->',
      '',
      '# Bölüm 1',
      '',
      'Kısa giriş.',
      '',
      sentences(120),
      '',
      'Önemli son not: dozaj 5 mg.',
    ].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 256, minTokens: 50 })
    const all = chunks.map((c) => c.text).join('\n')
    expect(missingWords(md, all)).toEqual([])
    expect(all).toContain('# Bölüm 1')
    expect(all).toContain('Kısa giriş.')
    expect(all).toContain('dozaj 5 mg')
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(256)
  })

  it('assigns the real page range to chunks of a section spanning many pages', () => {
    const lines = ['<!-- page 1 -->', '', '# Uzun Bölüm', '']
    for (let p = 1; p <= 6; p++) {
      if (p > 1) lines.push(`<!-- page ${p} -->`, '')
      lines.push(`Sayfa${p} başlangıcı. ${sentences(25, p * 100)}`, '')
    }
    const { chunks, pageCount } = chunkMarkdownDocument(lines.join('\n'), { maxTokens: 300, minTokens: 20 })
    expect(pageCount).toBe(6)
    for (const c of chunks) {
      const pages = [...c.text.matchAll(/Sayfa(\d)/g)].map((m) => Number(m[1]))
      for (const p of pages) {
        expect(p).toBeGreaterThanOrEqual(c.pageStart)
        expect(p).toBeLessThanOrEqual(c.pageEnd)
      }
    }
    expect(chunks.at(-1)?.pageEnd).toBe(6)
    expect(new Set(chunks.map((c) => c.pageStart)).size).toBeGreaterThan(1)
  })

  it('gives repeated content distinct ids', () => {
    const tbl = '| A | B |\n|---|---|\n| 1 | 2 |'
    const md = ['## Ek', '', tbl, '', '<!-- page 2 -->', '', '## Ek', '', tbl].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { minTokens: 1 })
    const ids = assignChunkIds(chunks, 'a'.repeat(64))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('merges small chunks only within a section and never past maxTokens', () => {
    const md = ['## A', '', lorem(95), '', '## B', '', 'Kısa B metni.'].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 160, minTokens: 50 })
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(160)
    const withB = chunks.find((c) => c.text.includes('Kısa B'))
    expect(withB?.sectionPath).toEqual(['B'])
    expect(withB?.text).not.toContain('kelime1 ')
  })
})

describe('tables and code', () => {
  const header = '| Ad | Değer | Açıklama |\n|---|---|---|'
  const rows = Array.from({ length: 300 }, (_, i) => `| satır ${i} | değer ${i} | açıklama metni ${i} |`)

  it('splits large tables by rows and repeats the header in every part', () => {
    const md = ['## Tablo', '', 'Tablo 1. Laboratuvar değerleri', '', header, ...rows].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 512 })
    const tableChunks = chunks.filter((c) => c.contentType === 'table' || c.contentType === 'mixed')
    expect(tableChunks.length).toBeGreaterThan(5)
    for (const c of tableChunks) {
      expect(c.mustPreserve).toBe(true)
      expect(c.tokenCount).toBeLessThanOrEqual(512)
      expect(c.text).toContain('| Ad | Değer | Açıklama |')
      expect(c.text).toContain('|---|---|---|')
    }
    // Caption and heading travel with the first table part.
    expect(tableChunks[0]?.text.startsWith('## Tablo')).toBe(true)
    expect(tableChunks[0]?.text).toContain('Tablo 1. Laboratuvar')
    // Every row appears exactly once.
    const all = tableChunks.map((c) => c.text).join('\n')
    for (let i = 0; i < 300; i++) {
      expect(all.split(`| satır ${i} |`).length - 1).toBe(1)
    }
  })

  it('keeps fences on every part of a large code block', () => {
    const code = [
      '```ts',
      ...Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i}) // satır`),
      '```',
    ]
    const { chunks } = chunkMarkdownDocument(['# Kod', '', ...code].join('\n'), { maxTokens: 300 })
    const codeChunks = chunks.filter((c) => c.contentType === 'code' || c.mustPreserve)
    expect(codeChunks.length).toBeGreaterThan(3)
    for (const c of codeChunks) {
      expect(c.text).toMatch(/```ts\n/)
      expect(c.text.trimEnd().endsWith('```')).toBe(true)
      expect(c.tokenCount).toBeLessThanOrEqual(300)
    }
  })

  it('treats tables as normal text when preserveTables is false (still splitting with headers)', () => {
    const md = ['## T', '', header, ...rows.slice(0, 80)].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 256, preserveTables: false })
    expect(chunks.every((c) => !c.mustPreserve)).toBe(true)
    for (const c of chunks) {
      expect(c.text).toContain('| Ad | Değer | Açıklama |')
      expect(c.tokenCount).toBeLessThanOrEqual(256)
    }
  })
})

describe('structure', () => {
  it('starts a new chunk at H1/H2 and keeps headings with their content', () => {
    const md = ['# Kitap', '', '## Birinci', '', sentences(4), '', '## İkinci', '', sentences(4, 50)].join(
      '\n',
    )
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 512, minTokens: 10 })
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.text.startsWith('# Kitap\n\n## Birinci')).toBe(true)
    expect(chunks[0]?.sectionPath).toEqual(['Kitap', 'Birinci'])
    expect(chunks[1]?.text.startsWith('## İkinci')).toBe(true)
    expect(chunks[1]?.sectionPath).toEqual(['Kitap', 'İkinci'])
    expect(chunks[0]?.group).not.toBe(chunks[1]?.group)
  })

  it('does not leave a heading dangling at the end of a chunk', () => {
    const md = ['## A', '', lorem(100), '', '### Alt', '', lorem(100, 7)].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 150, minTokens: 10 })
    for (const c of chunks) expect(c.text.trimEnd().split('\n').at(-1)?.startsWith('#')).toBe(false)
    expect(chunks.some((c) => c.text.startsWith('### Alt'))).toBe(true)
  })

  it('splits long lists between items', () => {
    const items = Array.from({ length: 120 }, (_, i) => `- Madde ${i}: ${lorem(6, i)}`)
    const { chunks } = chunkMarkdownDocument(['## Liste', '', ...items].join('\n'), { maxTokens: 200 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(200)
      for (const line of c.text.split('\n').filter((l) => l.startsWith('- ')))
        expect(line).toMatch(/^- Madde \d+:/)
    }
  })

  it('builds sections per hard-boundary group', () => {
    const md = ['# A', '', 'a metni.', '', '## A1', '', 'a1 metni.', '', '# B', '', 'b metni.'].join('\n')
    const { sections } = chunkMarkdownDocument(md, {})
    expect(sections.map((s) => s.path)).toEqual([['A'], ['A', 'A1'], ['B']])
    expect(sections[1]?.text).toContain('a1 metni.')
  })

  it('handles empty and marker-only documents', () => {
    expect(chunkMarkdownDocument('', {}).chunks).toEqual([])
    expect(chunkMarkdownDocument('<!-- page 1 -->\n\n<!-- page 2 -->', {}).chunks).toEqual([])
  })

  it('normalises page markers that are glued to text', () => {
    const md = 'İlk sayfa metni.\n<!-- page 2 -->\nİkinci sayfa metni.'
    const { chunks } = chunkMarkdownDocument(md, { minTokens: 0 })
    const all = chunks.map((c) => c.text).join('\n')
    expect(all).not.toContain('<!--')
    expect(chunks.at(-1)?.pageEnd).toBe(2)
  })
})

describe('overlap', () => {
  it('adds trailing sentences of the previous chunk within a section only', () => {
    const md = ['## A', '', sentences(60), '', '## B', '', sentences(5, 900)].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 200, minTokens: 10, overlapTokens: 30 })
    const a = chunks.filter((c) => c.sectionPath[0] === 'A')
    expect(a.length).toBeGreaterThan(1)
    expect(a[0]?.overlap).toBe('')
    expect(a[1]?.overlap.length).toBeGreaterThan(0)
    expect(tok.count(a[1]?.overlap ?? '')).toBeLessThanOrEqual(30)
    expect(a[0]?.text.endsWith(a[1]?.overlap ?? 'x')).toBe(true)
    const b = chunks.find((c) => c.sectionPath[0] === 'B')
    expect(b?.overlap).toBe('')
  })

  it('never puts overlap on or from preserved chunks, and ids ignore overlap', () => {
    const md = ['## A', '', sentences(10), '', '| x | y |\n|---|---|\n| 1 | 2 |', '', sentences(10, 40)].join(
      '\n',
    )
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 512, minTokens: 0, overlapTokens: 20 })
    for (const c of chunks) if (c.mustPreserve) expect(c.overlap).toBe('')
    const withOverlap = chunks.map((c) => ({ ...c, overlap: 'farklı' }))
    expect(assignChunkIds(withOverlap, 'f'.repeat(64))).toEqual(assignChunkIds(chunks, 'f'.repeat(64)))
  })

  it('builds content as context, overlap, raw', () => {
    expect(buildContent('Özet.', 'Önceki cümle.', '## X\n\nMetin')).toBe(
      'Context: Özet.\n\nÖnceki cümle.\n\n## X\n\nMetin',
    )
    expect(buildContent('', '', 'Metin')).toBe('Metin')
  })
})

describe('splitToBudget', () => {
  it('hard-splits a single huge word and reproduces the input exactly', () => {
    const word = 'a'.repeat(5000)
    const pieces = splitToBudget(word, 100, tok)
    expect(pieces.join('')).toBe(word)
    for (const p of pieces) expect(tok.count(p)).toBeLessThanOrEqual(100)
  })

  it('prefers sentence boundaries for Turkish text', () => {
    const text = sentences(40)
    const pieces = splitToBudget(text, 60, tok)
    expect(pieces.join('')).toBe(text)
    for (const p of pieces) {
      expect(tok.count(p)).toBeLessThanOrEqual(60)
      expect(p.trimEnd().endsWith('.')).toBe(true)
    }
  })

  it('works with the estimate tokenizer', () => {
    const est = getTokenizer('estimate')
    const { chunks } = chunkMarkdownDocument(`# X\n\n${sentences(100)}`, {
      maxTokens: 128,
      tokenizer: 'estimate',
    })
    for (const c of chunks) expect(est.count(c.text)).toBeLessThanOrEqual(128)
  })
})

// ─── Property-based invariants ──────────────────────────────────────────────

const wordArb = fc.stringMatching(/^[a-zçğıöşü]{1,12}$/)
const sentenceArb = fc.array(wordArb, { minLength: 1, maxLength: 25 }).map((ws) => `${ws.join(' ')}.`)
const paragraphArb = fc.array(sentenceArb, { minLength: 1, maxLength: 30 }).map((ss) => ss.join(' '))
const headingArb = fc
  .tuple(fc.integer({ min: 1, max: 4 }), fc.array(wordArb, { minLength: 1, maxLength: 5 }))
  .map(([d, ws]) => `${'#'.repeat(d)} ${ws.join(' ')}`)
const listArb = fc
  .array(fc.array(wordArb, { minLength: 1, maxLength: 15 }), { minLength: 1, maxLength: 25 })
  .map((items) => items.map((ws) => `- ${ws.join(' ')}`).join('\n'))
const tableArb = fc
  .array(fc.tuple(wordArb, wordArb, wordArb), { minLength: 1, maxLength: 60 })
  .map((rows) => ['| k | v | n |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n'))
const codeArb = fc
  .array(fc.array(wordArb, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 40 })
  .map((lines) => ['```', ...lines.map((l) => l.join(' ')), '```'].join('\n'))
const blockArb = fc.oneof(
  { weight: 5, arbitrary: paragraphArb },
  { weight: 2, arbitrary: headingArb },
  { weight: 1, arbitrary: listArb },
  { weight: 1, arbitrary: tableArb },
  { weight: 1, arbitrary: codeArb },
  { weight: 1, arbitrary: fc.constant('PAGE') },
)
const docArb = fc.array(blockArb, { minLength: 0, maxLength: 40 }).map((blocks) => {
  let page = 1
  const out = ['<!-- page 1 -->']
  for (const b of blocks) out.push(b === 'PAGE' ? `<!-- page ${++page} -->` : b)
  return out.join('\n\n')
})
const optsArb = fc.record({
  maxTokens: fc.integer({ min: 96, max: 700 }),
  minTokens: fc.integer({ min: 0, max: 60 }),
  overlapTokens: fc.integer({ min: 0, max: 30 }),
  hardBoundaryDepth: fc.integer({ min: 0, max: 3 }),
  preserveTables: fc.boolean(),
  preserveCode: fc.boolean(),
})

describe('chunker invariants (property-based)', () => {
  it('preserves every word, respects maxTokens and reports valid page ranges', () => {
    fc.assert(
      fc.property(docArb, optsArb, (doc, opts) => {
        const { chunks, pageCount } = chunkMarkdownDocument(doc, opts)
        const all = chunks.map((c) => c.text).join('\n\n')
        expect(missingWords(doc, all)).toEqual([])
        for (const c of chunks) {
          expect(c.tokenCount).toBeLessThanOrEqual(opts.maxTokens)
          expect(c.pageStart).toBeGreaterThanOrEqual(1)
          expect(c.pageEnd).toBeGreaterThanOrEqual(c.pageStart)
          expect(c.pageEnd).toBeLessThanOrEqual(pageCount)
          expect(c.text).not.toMatch(/<!--\s*page/)
          expect(c.text.trim().length).toBeGreaterThan(0)
        }
        const ids = assignChunkIds(chunks, 'd'.repeat(64))
        expect(new Set(ids).size).toBe(ids.length)
      }),
      { numRuns: 250 },
    )
  })

  it('keeps every character in order, even with tiny budgets that force mid-word cuts', () => {
    const strip = (s: string) => s.replace(/<!--\s*page\s+\d+\s*-->/gi, '').replace(/\s+/g, '')
    fc.assert(
      fc.property(docArb, fc.integer({ min: 32, max: 120 }), (doc, maxTokens) => {
        const { chunks } = chunkMarkdownDocument(doc, { maxTokens, minTokens: 0, hardBoundaryDepth: 2 })
        const input = strip(doc)
        const output = strip(chunks.map((c) => c.text).join(''))
        let j = 0
        for (let i = 0; i < output.length && j < input.length; i++) if (output[i] === input[j]) j++
        expect(j).toBe(input.length)
      }),
      { numRuns: 150 },
    )
  })

  it('is deterministic', () => {
    fc.assert(
      fc.property(docArb, optsArb, (doc, opts) => {
        expect(chunkMarkdownDocument(doc, opts)).toEqual(chunkMarkdownDocument(doc, opts))
      }),
      { numRuns: 50 },
    )
  })

  it('attributes every word to a page inside the chunk range', () => {
    fc.assert(
      fc.property(fc.array(paragraphArb, { minLength: 1, maxLength: 12 }), (pages) => {
        const doc = pages.map((p, i) => `<!-- page ${i + 1} -->\n\np${i + 1}x ${p}`).join('\n\n')
        const { chunks } = chunkMarkdownDocument(doc, { maxTokens: 120, minTokens: 0 })
        for (const c of chunks) {
          for (const m of c.text.matchAll(/p(\d+)x/g)) {
            const p = Number(m[1])
            expect(p).toBeGreaterThanOrEqual(c.pageStart)
            expect(p).toBeLessThanOrEqual(c.pageEnd)
          }
        }
        expect(words(chunks.map((c) => c.text).join(' ')).length).toBeGreaterThan(0)
      }),
      { numRuns: 100 },
    )
  })
})

describe('real-world text', () => {
  it('does not nest headings that follow a reference list under it', () => {
    const md = [
      '# Riskler',
      '',
      '## Kaynaklar',
      '',
      '1. Bayram F, et al. Prevalence of Hypertension. 2010.',
      '',
      '#### 2) Cinsiyet',
      '',
      'Kadınlarda sistolik kan basıncı erken yetişkinlikte daha düşüktür.',
    ].join('\n')
    const { chunks } = chunkMarkdownDocument(md, { maxTokens: 30, minTokens: 0 })
    const last = chunks.at(-1)
    expect(last?.text).toContain('Kadınlarda')
    expect(last?.sectionPath).toEqual(['Riskler', '2) Cinsiyet'])
  })

  it('treats special-token look-alikes such as <|im_start|> as plain text', () => {
    const md =
      '## Chat format\n\n<|im_start|>user\nMerhaba<|im_end|>\n<|im_start|>assistant\nSelam<|im_end|> <|endoftext|>'
    expect(tok.count('<|endoftext|>')).toBeGreaterThan(1)
    expect(tok.truncate('<|im_start|> abc def', 3).length).toBeGreaterThan(0)
    const { chunks } = chunkMarkdownDocument(md, { minTokens: 0 })
    expect(chunks.map((c) => c.text).join('\n')).toContain('<|im_start|>assistant')
  })

  it('does not warn when long list items or paragraphs are split at sentences', () => {
    const items = Array.from({ length: 3 }, (_, i) => `- Madde ${i}: ${sentences(80, i * 10)}`)
    const { warnings } = chunkMarkdownDocument(['## Liste', '', ...items].join('\n'), { maxTokens: 256 })
    expect(warnings).toEqual([])
  })
})
