import { describe, expect, it } from 'vitest'
import { evaluate, type QuestionSet } from '../../src/eval/eval.js'
import { createReranker, hasReranker } from '../../src/local/reranker.js'
import { hasOnnxRuntime } from '../../src/local/runtime.js'
import type { Chunk } from '../../src/types.js'

/**
 * Runs the real mMARCO MiniLM cross-encoder. Needs onnxruntime-node; downloads the model
 * (120 MB) when it is not in the models directory (RAG_CHUNKER_MODELS_DIR).
 */
const ready = await hasOnnxRuntime()

const chunk = (i: number, text: string): Chunk => ({
  chunkId: `c${i}`,
  documentId: 'd',
  source: 'doc.md',
  index: i,
  content: text,
  rawContent: text,
  contextSummary: '',
  tokenCount: 20,
  contentType: 'text',
  sectionPath: [],
  pageStart: 1,
  pageEnd: 1,
  ocrSource: 'markdown',
  boxes: [],
  prevChunkId: null,
  nextChunkId: null,
  mustPreserve: false,
  embedding: [],
})

describe.skipIf(!ready)('mmarco-minilm reranker (live)', () => {
  it('scores relevant Turkish and English passages above unrelated ones', async () => {
    const reranker = await createReranker('mmarco-minilm')
    expect(await hasReranker('mmarco-minilm')).toBe(true)
    const scores = await reranker.score('Hiponatremi nasıl tedavi edilir?', [
      'Hiponatremi tedavisinde serum sodyumu yavaş yükseltilir; hızlı düzeltme ozmotik demiyelinizasyona yol açar.',
      'Potasyum yüksekliği (hiperkalemi) EKG değişiklikleri yapabilir ve kalsiyum glukonat verilir.',
      'The treatment of hyponatremia depends on its cause and severity; hypertonic saline is used for severe symptoms.',
      'Toplantı yarın saat 10:00’da yapılacaktır.',
    ])
    expect(scores[0]).toBeGreaterThan(0.7)
    expect(scores[2]).toBeGreaterThan(0.7)
    expect(scores[1]).toBeLessThan(0.3)
    expect(scores[3]).toBeLessThan(0.3)
  }, 300_000)

  it('lifts the answer above a keyword-heavy distractor in the rerank mode of an evaluation', async () => {
    const reranker = await createReranker('mmarco-minilm')
    const chunks = [
      chunk(
        0,
        'Hiponatremi hiponatremi hiponatremi: sık görülen bir elektrolit bozukluğudur ve birçok nedeni vardır.',
      ),
      chunk(1, 'Ağır semptomlu hastalarda hipertonik salin ile sodyum saatte 1-2 mmol/L artırılır.'),
      chunk(2, 'Hiperkalemi tedavisinde insülin ve glukoz uygulanır.'),
    ]
    const set: QuestionSet = {
      version: 1,
      documentId: 'd',
      source: 'doc.md',
      model: 'live',
      questions: [
        {
          id: 0,
          question: 'Ağır hiponatremide sodyum nasıl ve ne hızla yükseltilir?',
          evidence: 'hipertonik salin ile sodyum saatte 1-2 mmol/L artırılır',
          page: 1,
        },
      ],
    }
    const report = await evaluate(set, chunks, 'live', undefined, { reranker })
    expect(report.ranks[0]?.ranks.rerank).toBe(1)
  }, 300_000)
})
