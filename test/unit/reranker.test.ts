import { describe, expect, it } from 'vitest'
import { evaluate, type QuestionSet } from '../../src/eval/eval.js'
import { lazyReranker, type TokenizerJson, UnigramTokenizer } from '../../src/local/reranker.js'
import { buildSearchIndex, type Reranker, rerank, rerankText } from '../../src/search/search.js'
import type { Chunk } from '../../src/types.js'

/** A tiny Unigram vocabulary: whole words score better than their pieces, "x" is unknown. */
const vocab: TokenizerJson = {
  model: {
    type: 'Unigram',
    unk_id: 3,
    vocab: [
      ['<s>', 0],
      ['<pad>', 0],
      ['</s>', 0],
      ['<unk>', 0],
      ['▁', -3],
      ['▁merhaba', -8],
      ['▁mer', -6],
      ['haba', -5],
      ['▁dünya', -8.5],
      ['▁d', -4],
      ['ü', -2],
      ['n', -2],
      ['y', -2],
      ['a', -2],
      ['s', -2],
      [',', -3],
      ['▁a', -5],
    ],
  },
  added_tokens: [
    { id: 0, content: '<s>' },
    { id: 1, content: '<pad>' },
    { id: 2, content: '</s>' },
    { id: 3, content: '<unk>' },
  ],
}

describe('Unigram tokenizer', () => {
  const tok = new UnigramTokenizer(vocab)
  const id = (t: string) => vocab.model.vocab.findIndex(([v]) => v === t)

  it('segments with the best-scoring path, prefixes words with the metaspace and handles unknowns', () => {
    // "merhaba" as one token (-8) beats "mer" + "haba" (-11).
    expect(tok.encode('merhaba')).toEqual([id('▁merhaba')])
    // "dünya" whole (-8.5) beats ▁d ü n y a (-12).
    expect(tok.encode('merhaba  dünya')).toEqual([id('▁merhaba'), id('▁dünya')])
    // Letters outside the vocabulary (here the capital) become one fused <unk>.
    expect(tok.encode('Merhaba')).toEqual([id('▁'), 3, id('haba')])
    // NFKC folds the full-width comma; "x" is not in the vocabulary: one <unk>, consecutive ones fused.
    expect(tok.encode('merhaba，')).toEqual([id('▁merhaba'), id(',')])
    expect(tok.encode('xx')).toEqual([id('▁'), 3])
    expect(tok.encode('axxa')).toEqual([id('▁a'), 3, id('a')])
    expect(tok.encode('   ')).toEqual([])
  })

  it('builds XLM-R pairs and truncates the passage first', () => {
    expect(tok.encodePair('merhaba', 'dünya', 512)).toEqual([0, id('▁merhaba'), 2, 2, id('▁dünya'), 2])
    const long = tok.encodePair('merhaba', 'dünya dünya dünya dünya', 8)
    expect(long).toHaveLength(8)
    expect(long.slice(0, 3)).toEqual([0, id('▁merhaba'), 2])
    expect(long.at(-1)).toBe(2)
  })

  it('rejects other tokenizer models', () => {
    expect(() => new UnigramTokenizer({ model: { type: 'WordPiece', vocab: [] } })).toThrow(/Unsupported/)
  })
})

const chunk = (i: number, text: string, section = 'Bölüm'): Chunk => ({
  chunkId: `c${i}`,
  documentId: 'd',
  source: 'doc.md',
  index: i,
  content: text,
  rawContent: text,
  contextSummary: '',
  tokenCount: 10,
  contentType: 'text',
  sectionPath: [section],
  pageStart: 1,
  pageEnd: 1,
  ocrSource: 'markdown',
  boxes: [],
  prevChunkId: null,
  nextChunkId: null,
  mustPreserve: false,
  embedding: [],
})

/** A reranker that likes the word "tedavi" (treatment) and nothing else. */
const likesTedavi: Reranker = {
  id: 'fake',
  async score(_q, texts) {
    return texts.map((t) => (t.includes('tedavi') ? 0.9 : 0.1))
  },
}

describe('rerank()', () => {
  const chunks = [
    chunk(0, 'Hiponatremi tanımı: serum sodyumu 135 mmol/L altındadır.'),
    chunk(1, 'Hiponatremi belirtileri bulantı, baş ağrısı ve konfüzyondur.'),
    chunk(2, 'Hiponatremi tedavisi: sodyum yavaş yükseltilir.'),
    chunk(3, 'Kalsiyum metabolizması ve D vitamini.'),
  ]
  const index = buildSearchIndex(chunks)

  it('reorders the first-stage candidates by the cross-encoder score and keeps topK', async () => {
    expect(index.bm25.scores('hiponatremi').filter((s) => s > 0)).toHaveLength(3)
    const hits = await rerank(index, 'hiponatremi', { reranker: likesTedavi, topK: 2, candidates: 10 })
    expect(hits.map((h) => h.chunk.chunkId)).toEqual(['c2', expect.any(String)])
    expect(hits[0]).toMatchObject({ score: 0.9, rank: 1 })
    expect(hits[1]?.rank).toBe(2)
    // Chunks the first stage did not return are never reranked in.
    expect(hits.map((h) => h.chunk.chunkId)).not.toContain('c3')
  })

  it('gives the reranker the section path and context with the text', () => {
    const c = { ...chunk(0, 'metin'), contextSummary: 'özet', sectionPath: ['A', 'B'] }
    expect(rerankText(c)).toBe('A › B\nözet\nmetin')
    expect(rerankText(chunk(0, 'x'.repeat(5000))).length).toBeLessThanOrEqual(4000)
  })

  it('adds a rerank mode to the evaluation when a reranker is given', async () => {
    const set: QuestionSet = {
      version: 1,
      documentId: 'd',
      source: 'doc.md',
      model: 'test',
      questions: [
        { id: 0, question: 'hiponatremi nasıl tedavi edilir', evidence: 'sodyum yavaş yükseltilir', page: 1 },
      ],
    }
    const report = await evaluate(set, chunks, 'out', undefined, { reranker: likesTedavi })
    expect(report.metrics.map((m) => m.mode)).toEqual(['bm25', 'rerank'])
    const rr = report.metrics.find((m) => m.mode === 'rerank')
    expect(rr?.hitAt1).toBe(1)
    expect(report.ranks[0]?.ranks.rerank).toBe(1)
  })
})

describe('lazyReranker()', () => {
  it('creates the model on the first query only, once, and retries after a failure', async () => {
    let created = 0
    let fail = true
    const create = async (id: string): Promise<Reranker> => {
      created++
      if (fail) throw new Error('download failed')
      return { id, score: async (_q, texts) => texts.map((_t, i) => 1 - i / 10) }
    }
    const lazy = lazyReranker('mmarco-minilm', {}, create as never)
    expect(created).toBe(0)
    expect(lazy.id).toBe('mmarco-minilm')
    await expect(lazy.score('q', ['a'])).rejects.toThrow('download failed')
    fail = false
    expect(await lazy.score('q', ['a', 'b'])).toEqual([1, 0.9])
    expect(await lazy.score('q', ['c'])).toEqual([1])
    expect(created).toBe(2)
  })
})
