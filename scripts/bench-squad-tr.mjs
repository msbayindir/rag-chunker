#!/usr/bin/env node
/**
 * SQuAD-TR retrieval benchmark: human-written Turkish questions over Wikipedia paragraphs
 * (boun-tabi/squad_tr, development split, machine-translated SQuAD 2.0 with answers checked).
 * Every paragraph is one chunk; for a sample of answerable questions we measure how often the
 * paragraph the question was written for is retrieved, by BM25, vectors, hybrid and the reranker.
 * This exercises the search stack on Turkish (tokenisation, embedding model, cross-encoder), not
 * the chunker.
 *
 * usage: node scripts/bench-squad-tr.mjs --data <dir> [--questions 500] [--seed 42]
 *        [--embedding ollama/embeddinggemma] [--rerank [id]] [--out file.json]
 *
 * <dir>/data/squad-tr-dev.json is squad-tr-dev-v1.0.0.json from
 * https://github.com/boun-tabi/squad-tr (CC BY-NC-ND 4.0; not redistributed with this package).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : (args[i + 1] ?? true)) : undefined
}
const dataDir = flag('--data')
if (typeof dataDir !== 'string') {
  console.error('usage: node scripts/bench-squad-tr.mjs --data <dir> [options]')
  process.exit(2)
}
const sampleSize = typeof flag('--questions') === 'string' ? Number(flag('--questions')) : 500
const seed = typeof flag('--seed') === 'string' ? Number(flag('--seed')) : 42
const embeddingModel = typeof flag('--embedding') === 'string' ? flag('--embedding') : undefined
const rerankFlag = flag('--rerank')
const out =
  typeof flag('--out') === 'string' ? flag('--out') : join(root, 'bench', 'results', 'squad-tr.json')

const dist = (p) => import(pathToFileURL(join(root, 'dist', p)).href)
const api = await dist('index.js')
const { PACKAGE_VERSION } = await dist('output/manifest.js')
const {
  resolveConfig,
  buildSearchIndex,
  search,
  rerank,
  createReranker,
  resolveReranker,
  readDotEnv,
  embedTexts,
} = api
const env = { ...(await readDotEnv(join(root, '.env')).catch(() => ({}))), ...process.env }

// ── Corpus and questions ──────────────────────────────────────────────────────────────────────
const data = JSON.parse(await readFile(join(dataDir, 'data', 'squad-tr-dev.json'), 'utf8')).data
const chunks = []
const questions = []
for (const article of data) {
  for (const paragraph of article.paragraphs) {
    const index = chunks.length
    chunks.push({
      chunkId: `squad-tr-${index}`,
      documentId: 'squad-tr-dev',
      source: 'squad-tr-dev',
      index,
      content: paragraph.context,
      rawContent: paragraph.context,
      contextSummary: '',
      tokenCount: 0,
      contentType: 'text',
      sectionPath: [article.title],
      pageStart: 1,
      pageEnd: 1,
      ocrSource: 'text-layer',
      prevChunkId: null,
      nextChunkId: null,
      embedding: [],
    })
    for (const qa of paragraph.qas) {
      if (!qa.answers?.length || qa.is_impossible) continue
      questions.push({
        id: qa.id,
        question: qa.question,
        answers: qa.answers.map((a) => a.text),
        paragraph: index,
      })
    }
  }
}
// Seeded shuffle (mulberry32) so the sample is the same on every machine.
let state = seed >>> 0
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
for (let i = questions.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1))
  const tmp = questions[i]
  questions[i] = questions[j]
  questions[j] = tmp
}
const sample = questions.slice(0, sampleSize)

// ── Embeddings and reranker ───────────────────────────────────────────────────────────────────
const config = resolveConfig({ cache: { enabled: false } })
const rerankPlan = await resolveReranker(config, rerankFlag)
const reranker = rerankPlan.id ? await createReranker(rerankPlan.id) : undefined
console.log(
  `SQuAD-TR · ${chunks.length} paragraphs, ${questions.length} answerable questions, sample ${sample.length} (seed ${seed}) · embedding ${embeddingModel ?? 'off'} · rerank ${rerankPlan.id ?? 'off'} · rag-chunker ${PACKAGE_VERSION}\n`,
)
const timings = {}
let queryVectors = null
if (embeddingModel) {
  const t0 = Date.now()
  const vectors = await embedTexts(
    chunks.map((c) => `${c.sectionPath.join(' ')}\n${c.rawContent}`),
    embeddingModel,
    { kind: 'document', env, config: { cache: { enabled: false } } },
  )
  for (const [i, c] of chunks.entries()) c.embedding = vectors[i]
  timings.embedParagraphsMs = Date.now() - t0
  const t1 = Date.now()
  queryVectors = await embedTexts(
    sample.map((q) => q.question),
    embeddingModel,
    { kind: 'query', env, config: { cache: { enabled: false } } },
  )
  timings.embedQuestionsMs = Date.now() - t1
  console.log(
    `  embedded ${chunks.length} paragraphs in ${(timings.embedParagraphsMs / 1000).toFixed(0)} s, ${sample.length} questions in ${(timings.embedQuestionsMs / 1000).toFixed(0)} s`,
  )
}
const index = buildSearchIndex(chunks)
const modes = ['bm25', ...(queryVectors ? ['vector', 'hybrid'] : []), ...(reranker ? ['rerank'] : [])]

// ── Retrieval ─────────────────────────────────────────────────────────────────────────────────
const normalize = (t) => t.normalize('NFKC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim()
const results = sample.map((q) => ({ id: q.id, question: q.question, ranks: {}, lenientRanks: {} }))
for (const mode of modes) {
  const t0 = Date.now()
  for (const [i, q] of sample.entries()) {
    const hits =
      mode === 'rerank'
        ? await rerank(index, q.question, {
            reranker,
            topK: 10,
            candidates: config.rerank.candidates,
            firstStage: queryVectors ? 'hybrid' : 'bm25',
            queryVector: queryVectors?.[i],
          })
        : search(index, q.question, { topK: 10, mode, queryVector: queryVectors?.[i] })
    const exact = hits.find((h) => h.chunk.index === q.paragraph)
    const answers = q.answers.map(normalize).filter(Boolean)
    const lenient = hits.find((h) => {
      const text = normalize(h.chunk.rawContent)
      return answers.some((a) => text.includes(a))
    })
    results[i].ranks[mode] = exact ? exact.rank : 0
    results[i].lenientRanks[mode] = lenient ? lenient.rank : 0
  }
  timings[`${mode}Ms`] = Date.now() - t0
  console.log(`  ${mode.padEnd(7)} ${((Date.now() - t0) / sample.length).toFixed(0)} ms/question`)
}

// ── Aggregate ─────────────────────────────────────────────────────────────────────────────────
const metricsFor = (key, mode) => {
  const rs = results.map((r) => r[key][mode] ?? 0)
  const n = Math.max(1, rs.length)
  const hit = (k) => rs.filter((r) => r > 0 && r <= k).length / n
  return {
    questions: rs.length,
    hitAt1: hit(1),
    hitAt5: hit(5),
    hitAt10: hit(10),
    mrr: rs.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / n,
  }
}
const summary = {
  benchmark: 'SQuAD-TR dev (boun-tabi) — retrieval of the source paragraph for Turkish questions',
  date: new Date().toISOString(),
  version: PACKAGE_VERSION,
  platform: `${process.platform}-${process.arch}`,
  settings: {
    questions: sample.length,
    seed,
    paragraphs: chunks.length,
    embedding: embeddingModel ?? null,
    rerank: rerankPlan.id ?? null,
    candidates: config.rerank.candidates,
  },
  timings,
  results: Object.fromEntries(
    modes.map((m) => [m, { exact: metricsFor('ranks', m), answerInText: metricsFor('lenientRanks', m) }]),
  ),
  perQuestion: results,
}
await mkdir(join(out, '..'), { recursive: true })
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`)

const pct = (x) => `${(100 * x).toFixed(0)} %`
console.log('\n| Mode | hit@1 | hit@5 | hit@10 | MRR | MRR (answer text in paragraph) |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const m of modes) {
  const e = summary.results[m].exact
  console.log(
    `| ${m} | ${pct(e.hitAt1)} | ${pct(e.hitAt5)} | ${pct(e.hitAt10)} | ${e.mrr.toFixed(3)} | ${summary.results[m].answerInText.mrr.toFixed(3)} |`,
  )
}
console.log(`\nwritten ${out}`)
