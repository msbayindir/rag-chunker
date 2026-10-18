import { z } from 'zod'
import type { CacheStore } from '../cache/store.js'
import { splitPages } from '../ocr/postprocess.js'
import type { Reporter } from '../pipeline/events.js'
import { generateJson } from '../providers/structured.js'
import { addUsage, emptyUsage, type LLM, type Usage } from '../providers/types.js'
import { buildSearchIndex, type Reranker, rerank, type SearchMode, search } from '../search/search.js'
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
Given a passage from a longer document, write ONE specific question that a user of that document could ask and that this passage answers.
- Phrase it the way a user would, in your own words: do not copy distinctive phrases or rare terms from the passage unless the question cannot be asked without them.
- Make it self-contained: name the subject it is about so it makes sense without the passage (not "What does the table show?").
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
      const key = opts.cache.key('eval', 'v2', opts.llm.ref, sha256(p.text))
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

/**
 * Measures how well each search mode finds the chunk that holds each question's evidence. With a
 * reranker, a `rerank` mode (hybrid or BM25 candidates reordered by the cross-encoder) is added.
 */
export async function evaluate(
  set: QuestionSet,
  chunks: Chunk[],
  output: string,
  queryVectors?: number[][],
  options: { reranker?: Reranker; candidates?: number; signal?: AbortSignal } = {},
): Promise<EvalReport> {
  const index = buildSearchIndex(chunks)
  const vectors = index.hasVectors && !!queryVectors
  const modes: SearchMode[] = ['bm25']
  if (vectors) modes.push('vector', 'hybrid')
  if (options.reranker) modes.push('rerank')
  const ranks: EvalReport['ranks'] = set.questions.map((q) => ({ id: q.id, question: q.question, ranks: {} }))
  for (const mode of modes) {
    for (const [i, q] of set.questions.entries()) {
      const hits =
        mode === 'rerank'
          ? await rerank(index, q.question, {
              reranker: options.reranker as Reranker,
              topK: 10,
              candidates: options.candidates,
              firstStage: vectors ? 'hybrid' : 'bm25',
              queryVector: queryVectors?.[i],
              signal: options.signal,
            })
          : search(index, q.question, { topK: 10, mode, queryVector: queryVectors?.[i] })
      const found = hits.find((h) => isRelevant(h.chunk, q.evidence))
      ;(ranks[i] as EvalReport['ranks'][number]).ranks[mode] = found ? found.rank : 0
    }
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

export interface ComparisonColumn {
  label: string
  mode: SearchMode
  metrics: ModeMetrics
  /** Rank of the first relevant chunk per question (0 = not in the top 10). */
  ranks: number[]
  /** Questions ranked better / worse than in the first column. */
  improved: number
  regressed: number
  deltaMrr: number
}

export interface Comparison {
  questions: Array<{ id: number; question: string }>
  /** Several outputs in one mode, or the modes of a single output; the first column is the baseline. */
  columns: ComparisonColumn[]
}

const MODE_PRIORITY: SearchMode[] = ['rerank', 'hybrid', 'vector', 'bm25']

/** A rank beats another when it is found and the other is not, or when it is smaller. */
const better = (a: number, b: number) => a > 0 && (b === 0 || a < b)

/**
 * Compares outputs evaluated on the same questions: with several reports, in the best mode they
 * all have; with one report, its modes against each other. Deltas are against the first column.
 */
export function compareReports(reports: EvalReport[], labels: string[]): Comparison {
  const first = reports[0]
  if (!first) throw new Error('compareReports needs at least one report')
  const questions = first.ranks.map((r) => ({ id: r.id, question: r.question }))
  const column = (label: string, mode: SearchMode, report: EvalReport): ComparisonColumn => ({
    label,
    mode,
    metrics: report.metrics.find((m) => m.mode === mode) as ModeMetrics,
    ranks: questions.map((q) => report.ranks.find((r) => r.id === q.id)?.ranks[mode] ?? 0),
    improved: 0,
    regressed: 0,
    deltaMrr: 0,
  })
  let columns: ComparisonColumn[]
  if (reports.length > 1) {
    const common =
      MODE_PRIORITY.find((m) => reports.every((r) => r.metrics.some((x) => x.mode === m))) ?? 'bm25'
    columns = reports.map((r, i) => column(labels[i] ?? r.output, common, r))
  } else {
    columns = first.metrics.map((m) => column(m.mode, m.mode, first))
  }
  const base = columns[0] as ComparisonColumn
  for (const c of columns.slice(1)) {
    c.improved = c.ranks.filter((r, i) => better(r, base.ranks[i] as number)).length
    c.regressed = c.ranks.filter((r, i) => better(base.ranks[i] as number, r)).length
    c.deltaMrr = c.metrics.mrr - base.metrics.mrr
  }
  return { questions, columns }
}
