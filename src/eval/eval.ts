import { z } from 'zod'
import type { CacheStore } from '../cache/store.js'
import { splitPages } from '../ocr/postprocess.js'
import type { Reporter } from '../pipeline/events.js'
import { generateJson } from '../providers/structured.js'
import { addUsage, emptyUsage, type LLM, type Usage } from '../providers/types.js'
import { buildSearchIndex, type SearchMode, search } from '../search/search.js'
import type { Chunk } from '../types.js'
import { mapPool } from '../util/async.js'
import { sha256 } from '../util/hash.js'

export interface EvalQuestion {
  id: number
  question: string
  /** Verbatim quote from the document that answers the question. */
  evidence: string
  page: number
}

export interface QuestionSet {
  version: 1
  documentId: string
  source: string
  model: string
  questions: EvalQuestion[]
}

export interface ModeMetrics {
  mode: SearchMode
  questions: number
  hitAt1: number
  hitAt3: number
  hitAt5: number
  hitAt10: number
  mrr: number
}

export interface EvalReport {
  output: string
  chunks: number
  metrics: ModeMetrics[]
  /** Rank of the first relevant chunk per question and mode (0 = not found in top 10). */
  ranks: Array<{ id: number; question: string; ranks: Partial<Record<SearchMode, number>> }>
}

const questionSchema = z.strictObject({ question: z.string(), evidence: z.string() })

const QUESTION_SYSTEM = `You create evaluation questions for a retrieval system.
Given a passage, write ONE specific question that a reader could ask and that this passage answers.
Also copy the shortest exact sentence or phrase from the passage (8-30 words) that contains the answer into "evidence" — copy it character for character.
Write the question in the same language as the passage. Do not mention "the passage" or "the text".
Return {"question":"...","evidence":"..."}.`

/** Lowercase, collapse whitespace and drop markdown punctuation so quotes match chunk text. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_`#>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A chunk is relevant when it contains the evidence (or a clear majority of it when it straddles chunks). */
export function isRelevant(chunk: Chunk, evidence: string): boolean {
  const text = normalizeForMatch(chunk.rawContent)
  const ev = normalizeForMatch(evidence)
  if (ev === '' || text.includes(ev)) return ev !== ''
  const words = ev.split(' ')
  if (words.length < 6) return false
  const half = Math.ceil(words.length * 0.6)
  return text.includes(words.slice(0, half).join(' ')) || text.includes(words.slice(-half).join(' '))
}

/** Deterministic pseudo-random generator (mulberry32) so question sampling is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks well-formed prose passages spread over the document. */
export function samplePassages(
  markdown: string,
  count: number,
  seed = 42,
): Array<{ text: string; page: number }> {
  const candidates: Array<{ text: string; page: number }> = []
  for (const page of splitPages(markdown)) {
    for (const block of page.markdown.split(/\n{2,}/)) {
      const t = block.trim()
      if (t.length < 160 || t.startsWith('|') || t.startsWith('```') || t.startsWith('#')) continue
      const letters = (t.match(/\p{L}/gu) ?? []).length
      if (letters / t.length < 0.6) continue
      candidates.push({ text: t.slice(0, 2400), page: page.pageNumber })
    }
  }
  if (candidates.length <= count) return candidates
  // Stratified sampling: one random passage from each of `count` equal slices.
  const random = rng(seed)
  const out: Array<{ text: string; page: number }> = []
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * candidates.length) / count)
    const end = Math.floor(((i + 1) * candidates.length) / count)
    out.push(
      candidates[start + Math.floor(random() * Math.max(1, end - start))] as { text: string; page: number },
    )
  }
  return out
}

/** Generates questions with verbatim evidence; questions whose evidence is not in the passage are dropped. */
export async function generateQuestions(
  input: { markdown: string; documentId: string; source: string },
  opts: {
    llm: LLM
    count: number
    cache: CacheStore
    reporter?: Reporter
    signal?: AbortSignal
    seed?: number
  },
): Promise<{ set: QuestionSet; usage: Usage }> {
  const usage = emptyUsage()
  const passages = samplePassages(input.markdown, opts.count, opts.seed)
  const results: Array<EvalQuestion | null> = new Array(passages.length).fill(null)
  let done = 0
  await mapPool(
    passages,
    opts.llm.provider.concurrency,
    async (p, i) => {
      const key = opts.cache.key('eval', 'v1', opts.llm.ref, sha256(p.text))
      let value = await opts.cache.get<{ question: string; evidence: string }>('eval', key)
      if (!value) {
        try {
          const res = await generateJson(
            opts.llm,
            {
              system: QUESTION_SYSTEM,
              parts: [{ type: 'text', text: p.text }],
              maxOutputTokens: 512,
              effort: 'low',
              signal: opts.signal,
            },
            questionSchema,
            'eval_question',
          )
          addUsage(usage, res.usage)
          value = res.value
          await opts.cache.set('eval', key, value)
        } catch (err) {
          opts.reporter?.warn(
            'context',
            `Question generation failed for a passage on page ${p.page}: ${(err as Error).message}`,
          )
        }
      }
      if (
        value &&
        normalizeForMatch(p.text).includes(normalizeForMatch(value.evidence)) &&
        value.question.trim() !== ''
      ) {
        results[i] = { id: i, question: value.question.trim(), evidence: value.evidence.trim(), page: p.page }
      }
      done++
      opts.reporter?.progress('context', done, passages.length, 'questions')
    },
    opts.signal,
  )
  const questions = results.filter((q): q is EvalQuestion => q !== null).map((q, id) => ({ ...q, id }))
  return {
    set: { version: 1, documentId: input.documentId, source: input.source, model: opts.llm.ref, questions },
    usage,
  }
}

/** Measures how well each search mode finds the chunk that holds each question's evidence. */
export function evaluate(
  set: QuestionSet,
  chunks: Chunk[],
  output: string,
  queryVectors?: number[][],
): EvalReport {
  const index = buildSearchIndex(chunks)
  const modes: SearchMode[] = ['bm25']
  if (index.hasVectors && queryVectors) modes.push('vector', 'hybrid')
  const ranks: EvalReport['ranks'] = set.questions.map((q) => ({ id: q.id, question: q.question, ranks: {} }))
  for (const mode of modes) {
    set.questions.forEach((q, i) => {
      const hits = search(index, q.question, { topK: 10, mode, queryVector: queryVectors?.[i] })
      const found = hits.find((h) => isRelevant(h.chunk, q.evidence))
      ;(ranks[i] as EvalReport['ranks'][number]).ranks[mode] = found ? found.rank : 0
    })
  }
  const metrics = modes.map((mode): ModeMetrics => {
    const rs = ranks.map((r) => r.ranks[mode] ?? 0)
    const n = Math.max(1, rs.length)
    const hit = (k: number) => rs.filter((r) => r > 0 && r <= k).length / n
    return {
      mode,
      questions: rs.length,
      hitAt1: hit(1),
      hitAt3: hit(3),
      hitAt5: hit(5),
      hitAt10: hit(10),
      mrr: rs.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / n,
    }
  })
  return { output, chunks: chunks.length, metrics, ranks }
}
