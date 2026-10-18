import type { Chunk } from '../types.js'

/**
 * Lowercases, removes diacritics and folds dotless ı so "Şeker", "şeker" and "seker" match.
 * Long words also index a 5-character prefix: a cheap stand-in for stemming in agglutinative
 * languages such as Turkish (hiponatremi / hiponatremide / hiponatreminin).
 */
export function searchTokens(text: string): string[] {
  const folded = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i')
  const words = folded.match(/[\p{L}\p{N}]+/gu) ?? []
  const out: string[] = []
  for (const w of words) {
    if (w.length < 2) continue
    out.push(w)
    if (w.length > 6) out.push(`${w.slice(0, 5)}*`)
  }
  return out
}

/** Okapi BM25 over chunk text. */
export class Bm25Index {
  private readonly docs: Array<Map<string, number>>
  private readonly lengths: number[]
  private readonly df = new Map<string, number>()
  private readonly avgLength: number

  constructor(
    texts: string[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.docs = texts.map((t) => {
      const tf = new Map<string, number>()
      for (const tok of searchTokens(t)) tf.set(tok, (tf.get(tok) ?? 0) + 1)
      return tf
    })
    this.lengths = this.docs.map((d) => [...d.values()].reduce((a, n) => a + n, 0))
    for (const d of this.docs) for (const term of d.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    this.avgLength = this.lengths.reduce((a, n) => a + n, 0) / Math.max(1, this.lengths.length)
  }

  scores(query: string): number[] {
    const terms = [...new Set(searchTokens(query))]
    const n = this.docs.length
    return this.docs.map((tf, i) => {
      let score = 0
      const len = this.lengths[i] as number
      for (const term of terms) {
        const f = tf.get(term)
        if (!f) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score +=
          (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / (this.avgLength || 1)))
      }
      return score
    })
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

function rank(scores: number[]): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .filter((s) => !Number.isNaN(s.score))
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .map((s) => s.index)
}

export type SearchMode = 'bm25' | 'vector' | 'hybrid' | 'rerank'

/** Scores (query, text) pairs with a cross-encoder; higher is more relevant. */
export interface Reranker {
  id: string
  score(query: string, texts: string[], signal?: AbortSignal): Promise<number[]>
}

export interface SearchHit {
  chunk: Chunk
  score: number
  rank: number
}

export interface SearchIndex {
  chunks: Chunk[]
  bm25: Bm25Index
  /** True when every chunk has an embedding of the same size. */
  hasVectors: boolean
}

export function buildSearchIndex(chunks: Chunk[]): SearchIndex {
  const dims = chunks[0]?.embedding.length ?? 0
  return {
    chunks,
    bm25: new Bm25Index(
      chunks.map((c) => `${c.sectionPath.join(' ')}\n${c.contextSummary}\n${c.rawContent}`),
    ),
    hasVectors: dims > 0 && chunks.every((c) => c.embedding.length === dims),
  }
}

/** Ranks chunks for a query: BM25, cosine similarity, or both fused with reciprocal rank fusion. */
export function search(
  index: SearchIndex,
  query: string,
  options: { topK?: number; mode?: SearchMode; queryVector?: number[] } = {},
): SearchHit[] {
  const topK = options.topK ?? 10
  const canVector = index.hasVectors && !!options.queryVector && options.queryVector.length > 0
  const mode: SearchMode = options.mode ?? (canVector ? 'hybrid' : 'bm25')
  if (mode === 'rerank') throw new Error('Reranking is asynchronous: use rerank()')
  if ((mode === 'vector' || mode === 'hybrid') && !canVector) {
    throw new Error('Vector search needs chunk embeddings and a query vector')
  }
  let order: Array<{ index: number; score: number }>
  if (mode === 'bm25') {
    const scores = index.bm25.scores(query)
    order = rank(scores)
      .filter((i) => (scores[i] as number) > 0)
      .map((i) => ({ index: i, score: scores[i] as number }))
  } else {
    const vec = options.queryVector as number[]
    const vscores = index.chunks.map((c) => cosine(vec, c.embedding))
    if (mode === 'vector') {
      order = rank(vscores).map((i) => ({ index: i, score: vscores[i] as number }))
    } else {
      const bscores = index.bm25.scores(query)
      const fused = new Map<number, number>()
      const k = 60
      for (const [r, i] of rank(vscores).entries()) fused.set(i, (fused.get(i) ?? 0) + 1 / (k + r + 1))
      const bm = rank(bscores).filter((i) => (bscores[i] as number) > 0)
      for (const [r, i] of bm.entries()) fused.set(i, (fused.get(i) ?? 0) + 1 / (k + r + 1))
      order = [...fused]
        .map(([index, score]) => ({ index, score }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
    }
  }
  return order
    .slice(0, topK)
    .map((o, i) => ({ chunk: index.chunks[o.index] as Chunk, score: o.score, rank: i + 1 }))
}

/** What the reranker reads for a chunk: its place in the document, its context and its text. */
export function rerankText(chunk: Chunk, maxChars = 4000): string {
  const head = chunk.sectionPath.join(' › ')
  return `${head ? `${head}\n` : ''}${chunk.contextSummary ? `${chunk.contextSummary}\n` : ''}${chunk.rawContent}`.slice(
    0,
    maxChars,
  )
}

/**
 * Two-stage search: the first stage (hybrid when vectors exist, else BM25) picks `candidates`
 * chunks, the cross-encoder reorders them and the best `topK` are returned with its scores.
 */
export async function rerank(
  index: SearchIndex,
  query: string,
  options: {
    reranker: Reranker
    topK?: number
    candidates?: number
    firstStage?: Exclude<SearchMode, 'rerank'>
    queryVector?: number[]
    signal?: AbortSignal
  },
): Promise<SearchHit[]> {
  const topK = options.topK ?? 10
  const candidates = Math.max(topK, options.candidates ?? 30)
  const first = search(index, query, {
    topK: candidates,
    mode: options.firstStage,
    queryVector: options.queryVector,
  })
  if (first.length === 0) return first
  const scores = await options.reranker.score(
    query,
    first.map((h) => rerankText(h.chunk)),
    options.signal,
  )
  return first
    .map((h, i) => ({ chunk: h.chunk, score: scores[i] ?? 0, first: h.rank }))
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, topK)
    .map((h, i) => ({ chunk: h.chunk, score: h.score, rank: i + 1 }))
}
