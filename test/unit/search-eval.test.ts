import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CacheStore } from '../../src/cache/store.js'
import {
  compareReports,
  evaluate,
  generateQuestions,
  isRelevant,
  normalizeForMatch,
  samplePassages,
} from '../../src/eval/eval.js'
import { chunkMarkdown } from '../../src/index.js'
import { Bm25Index, buildSearchIndex, cosine, search, searchTokens } from '../../src/search/search.js'
import type { Chunk } from '../../src/types.js'
import { FakeLLM } from '../helpers/fake-llm.js'

function withVectors(chunks: Chunk[], vec: (c: Chunk) => number[]): Chunk[] {
  return chunks.map((c) => ({ ...c, embedding: vec(c) }))
}

const md = [
  '# Elektrolitler',
  '',
  '## Hiponatremi',
  '',
  'Hiponatremi serum sodyumunun 135 mmol/L altına düşmesidir. Hipertonik salin akut olgularda kullanılır.',
  '',
  '## Hiperkalemi',
  '',
  'Hiperkalemi potasyumun 5,5 mmol/L üzerine çıkmasıdır. Kalsiyum glukonat kardiyak membranı korur.',
  '',
  '## Hipokalsemi',
  '',
  'Hipokalsemi tetani ve kas krampları yapar. Tedavide kalsiyum ve D vitamini verilir.',
].join('\n')

describe('search', () => {
  const chunks = chunkMarkdown(md, { minTokens: 0 })

  it('folds Turkish characters and indexes prefixes', () => {
    expect(searchTokens('Şeker İLAÇ ılık')).toEqual(['seker', 'ilac', 'ilik'])
    expect(searchTokens('hiponatreminin')).toContain('hipon*')
  })

  it('ranks the right chunk first with BM25, including inflected and unaccented queries', () => {
    const index = buildSearchIndex(chunks)
    expect(index.hasVectors).toBe(false)
    expect(search(index, 'potasyum yüksekliği')[0]?.chunk.sectionPath).toEqual([
      'Elektrolitler',
      'Hiperkalemi',
    ])
    expect(search(index, 'hiponatreminin tedavisi')[0]?.chunk.sectionPath.at(-1)).toBe('Hiponatremi')
    expect(search(index, 'kas kramplari')[0]?.chunk.sectionPath.at(-1)).toBe('Hipokalsemi')
    expect(search(index, 'tamamen alakasız kelimeler xyz')).toEqual([])
  })

  it('supports vector and hybrid search when embeddings exist', () => {
    const vecs: Record<string, number[]> = {
      Hiponatremi: [1, 0, 0],
      Hiperkalemi: [0, 1, 0],
      Hipokalsemi: [0, 0, 1],
    }
    const index = buildSearchIndex(
      withVectors(chunks, (c) => vecs[c.sectionPath.at(-1) ?? ''] ?? [0.1, 0.1, 0.1]),
    )
    expect(index.hasVectors).toBe(true)
    expect(
      search(index, 'x', { mode: 'vector', queryVector: [0, 0.9, 0.1] })[0]?.chunk.sectionPath.at(-1),
    ).toBe('Hiperkalemi')
    const hybrid = search(index, 'kalsiyum glukonat', { queryVector: [0, 1, 0] })
    expect(hybrid[0]?.chunk.sectionPath.at(-1)).toBe('Hiperkalemi')
    expect(() => search(buildSearchIndex(chunks), 'q', { mode: 'vector', queryVector: [1] })).toThrow(
      /embeddings/,
    )
  })

  it('computes cosine similarity and BM25 scores', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
    const bm = new Bm25Index(['kedi köpek', 'kedi kedi kedi', 'kuş'])
    const s = bm.scores('kedi')
    expect(s[1]).toBeGreaterThan(s[0] as number)
    expect(s[2]).toBe(0)
  })
})

describe('eval', () => {
  it('matches evidence across markdown formatting and chunk boundaries', () => {
    const chunk = chunkMarkdown('Bu **önemli** bir   cümledir ve devam eder burada.', {
      minTokens: 0,
    })[0] as Chunk
    expect(normalizeForMatch('Bu **önemli**  bir')).toBe('bu önemli bir')
    expect(isRelevant(chunk, 'önemli bir cümledir')).toBe(true)
    expect(isRelevant(chunk, 'bambaşka bir şey')).toBe(false)
    expect(isRelevant(chunk, 'önemli bir cümledir ve devam eder burada ama sonraki parçada sürer')).toBe(true)
    expect(isRelevant(chunk, '')).toBe(false)
  })

  it('samples prose passages deterministically and spread over the document', () => {
    const doc = Array.from(
      { length: 40 },
      (_, i) =>
        `<!-- page ${i + 1} -->\n\n${'Bu sayfa uzun bir paragraf içerir ve konu anlatır. '.repeat(5)}Sayfa ${i + 1}.`,
    ).join('\n\n')
    const a = samplePassages(doc, 8, 7)
    expect(a).toHaveLength(8)
    expect(samplePassages(doc, 8, 7)).toEqual(a)
    expect(a.at(-1)?.page).toBeGreaterThan(30)
    expect(samplePassages('kısa', 5)).toEqual([])
  })

  it('generates questions, drops ones with invented evidence and scores search modes', async () => {
    const doc = md.replace(
      /\. /g,
      '. Bu cümle açıklamayı uzatır, okuyucuya bağlam verir ve klinik önemini vurgular. ',
    )
    const llm = new FakeLLM((req) => {
      const text = req.parts[0]?.type === 'text' ? req.parts[0].text : ''
      if (text.includes('Hiperkalemi'))
        return JSON.stringify({
          question: 'Hiperkalemi nedir?',
          evidence: 'Hiperkalemi potasyumun 5,5 mmol/L üzerine çıkmasıdır.',
        })
      if (text.includes('Hiponatremi'))
        return JSON.stringify({
          question: 'Hiponatremi tanımı?',
          evidence: 'uydurma kanıt cümlesi burada yok',
        })
      return JSON.stringify({
        question: 'Hipokalsemi belirtileri?',
        evidence: 'Hipokalsemi tetani ve kas krampları yapar.',
      })
    })
    const cache = new CacheStore(await mkdtemp(join(tmpdir(), 'rc-eval-')))
    const { set } = await generateQuestions(
      { markdown: doc, documentId: 'd', source: 's.md' },
      { llm, count: 10, cache },
    )
    expect(set.questions.map((q) => q.question).sort()).toEqual([
      'Hiperkalemi nedir?',
      'Hipokalsemi belirtileri?',
    ])
    const chunks = chunkMarkdown(doc, { minTokens: 0 })
    const report = await evaluate(set, chunks, 'out')
    expect(report.metrics).toHaveLength(1)
    expect(report.metrics[0]).toMatchObject({ mode: 'bm25', questions: 2, hitAt1: 1, mrr: 1 })
    const vec = withVectors(chunks, (c) => [
      c.rawContent.includes('Hiperkalemi') ? 1 : 0,
      c.rawContent.includes('Hipokalsemi') ? 1 : 0,
    ])
    const withVec = await evaluate(
      set,
      vec,
      'out',
      set.questions.map((q) => (q.question.startsWith('Hiperkalemi') ? [1, 0] : [0, 1])),
    )
    expect(withVec.metrics.map((m) => m.mode)).toEqual(['bm25', 'vector', 'hybrid'])
    expect(withVec.metrics[1]?.hitAt1).toBe(1)
  })
})

describe('compareReports', () => {
  const report = (output: string, ranks: Record<string, number[]>) => ({
    output,
    chunks: 10,
    metrics: Object.entries(ranks).map(([mode, rs]) => ({
      mode: mode as 'bm25' | 'hybrid' | 'rerank',
      questions: rs.length,
      hitAt1: rs.filter((r) => r === 1).length / rs.length,
      hitAt3: rs.filter((r) => r > 0 && r <= 3).length / rs.length,
      hitAt5: rs.filter((r) => r > 0 && r <= 5).length / rs.length,
      hitAt10: rs.filter((r) => r > 0).length / rs.length,
      mrr: rs.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / rs.length,
    })),
    ranks: (ranks.bm25 as number[]).map((_, i) => ({
      id: i,
      question: `q${i}`,
      ranks: Object.fromEntries(Object.entries(ranks).map(([mode, rs]) => [mode, rs[i]])),
    })),
  })

  it('compares several outputs in the best mode they share, counting improved and regressed questions', () => {
    const a = report('a', { bm25: [1, 3, 0, 2], hybrid: [1, 2, 0, 2] })
    const b = report('b', { bm25: [1, 1, 4, 3], hybrid: [1, 1, 5, 2], rerank: [1, 1, 1, 1] })
    const cmp = compareReports([a, b], ['a', 'b'])
    expect(cmp.columns.map((c) => [c.label, c.mode])).toEqual([
      ['a', 'hybrid'],
      ['b', 'hybrid'],
    ])
    const col = cmp.columns[1]
    expect(col?.ranks).toEqual([1, 1, 5, 2])
    expect(col).toMatchObject({ improved: 2, regressed: 0 })
    expect(col?.deltaMrr).toBeCloseTo((1 + 1 + 0.2 + 0.5) / 4 - (1 + 0.5 + 0 + 0.5) / 4, 6)
  })

  it('compares the modes of a single output against its first mode', () => {
    const only = report('a', { bm25: [2, 0, 1], rerank: [1, 3, 2] })
    const cmp = compareReports([only], ['a'])
    expect(cmp.columns.map((c) => c.label)).toEqual(['bm25', 'rerank'])
    expect(cmp.columns[1]).toMatchObject({ improved: 2, regressed: 1 })
  })
})
