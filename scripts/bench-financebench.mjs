#!/usr/bin/env node
/**
 * FinanceBench retrieval benchmark: real analyst questions over 10-K/10-Q filings (PatronusAI,
 * open-source split: 150 questions over 84 filings), each with the verbatim evidence passage and
 * its page. Every filing is processed with the text layer (layout model optional), then we measure
 * how often the chunk that holds the evidence is retrieved — within the question's own filing and
 * across all filings in one index — for BM25, vectors, hybrid and the reranker.
 *
 * usage: node scripts/bench-financebench.mjs --data <dir> [--only 3M_2018_10K,...] [--limit N]
 *        [--embedding ollama/embeddinggemma] [--rerank [id]] [--first-stage bm25|vector|hybrid]
 *        [--candidates 30] [--layout|--no-layout] [--save <dir>] [--from <dir>] [--out file.json]
 *
 * <dir> holds data/financebench_open_source.jsonl and pdfs/<doc_name>.pdf, fetched from
 * https://github.com/patronus-ai/financebench (CC BY-NC 4.0; not redistributed with this package).
 * --save keeps each filing's chunks (with embeddings) so --from can re-run retrieval without
 * processing the PDFs again.
 */
import { existsSync } from 'node:fs'
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
  console.error('usage: node scripts/bench-financebench.mjs --data <dir> [options]')
  process.exit(2)
}
const only = typeof flag('--only') === 'string' ? flag('--only').split(',') : null
const limit = typeof flag('--limit') === 'string' ? Number(flag('--limit')) : 0
const embeddingModel = typeof flag('--embedding') === 'string' ? flag('--embedding') : undefined
const rerankFlag = flag('--rerank')
const layout = args.includes('--layout')
// Reranker first stage and candidate count (defaults: hybrid when embeddings exist, else BM25; 30).
const firstStageFlag = typeof flag('--first-stage') === 'string' ? flag('--first-stage') : null
const candidatesFlag = typeof flag('--candidates') === 'string' ? Number(flag('--candidates')) : null
const saveDir = typeof flag('--save') === 'string' ? flag('--save') : null
const fromDir = typeof flag('--from') === 'string' ? flag('--from') : null
const out =
  typeof flag('--out') === 'string' ? flag('--out') : join(root, 'bench', 'results', 'financebench.json')

const dist = (p) => import(pathToFileURL(join(root, 'dist', p)).href)
const api = await dist('index.js')
const { PACKAGE_VERSION } = await dist('output/manifest.js')
const {
  processDocument,
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

// ── Questions ─────────────────────────────────────────────────────────────────────────────────
const questions = (await readFile(join(dataDir, 'data', 'financebench_open_source.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
let docs = [...new Set(questions.map((q) => q.doc_name))].sort()
if (only) docs = docs.filter((d) => only.includes(d) || only.includes(`${d}.pdf`))
if (limit > 0) docs = docs.slice(0, limit)
const selected = questions.filter((q) => docs.includes(q.doc_name))

// ── Processing ────────────────────────────────────────────────────────────────────────────────
const config = resolveConfig({
  ocr: { engine: 'text-layer' },
  layout: { engine: layout ? 'pp-doclayout-v3' : 'off' },
  ...(embeddingModel ? { models: { embedding: embeddingModel } } : {}),
  figures: { extract: false },
  cache: { enabled: false },
})
const rerankPlan = await resolveReranker(config, rerankFlag)
const reranker = rerankPlan.id ? await createReranker(rerankPlan.id) : undefined
if (saveDir) await mkdir(saveDir, { recursive: true })

console.log(
  `FinanceBench · ${docs.length} filing(s), ${selected.length} question(s) · layout ${layout ? 'on' : 'off'} · embedding ${embeddingModel ?? 'off'} · rerank ${rerankPlan.id ?? 'off'} · rag-chunker ${PACKAGE_VERSION}\n`,
)
const filings = []
for (const doc of docs) {
  const saved = fromDir ? join(fromDir, `${doc}.json`) : null
  if (saved && existsSync(saved)) {
    filings.push(JSON.parse(await readFile(saved, 'utf8')))
    continue
  }
  const pdf = join(dataDir, 'pdfs', `${doc}.pdf`)
  if (!existsSync(pdf)) {
    console.log(`  ${doc}: pdf missing, skipped`)
    continue
  }
  const t0 = Date.now()
  let record
  try {
    const res = await processDocument(pdf, config, { env })
    record = {
      doc,
      pages: res.manifest.stages.ocr.pages,
      ms: Date.now() - t0,
      flags: res.manifest.quality?.flags ?? [],
      chunks: res.chunks,
    }
  } catch (err) {
    record = { doc, pages: 0, ms: Date.now() - t0, error: String(err?.message ?? err), chunks: [] }
  }
  filings.push(record)
  if (saveDir) await writeFile(join(saveDir, `${doc}.json`), JSON.stringify(record))
  console.log(
    `  ${doc.padEnd(42)} ${String(record.pages).padStart(4)} p  ${String(record.chunks.length).padStart(5)} chunks  ${(record.ms / 1000).toFixed(1).padStart(6)} s${record.error ? `  ✗ ${record.error}` : ''}`,
  )
}

// ── Relevance ─────────────────────────────────────────────────────────────────────────────────
// FinanceBench's evidence is a verbatim passage (often a whole table, median 170 words) with its
// 0-based page. A chunk counts as holding the evidence when it sits on that page (±1, the text
// layer and the dataset disagree on blank pages occasionally) and either covers at least half of
// the evidence's words or is itself almost entirely made of them (a long passage split over
// several chunks).
const words = (t) =>
  t
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
function relevant(chunk, evidence) {
  const page = evidence.evidence_page_num + 1
  if (chunk.pageStart > page + 1 || chunk.pageEnd < page - 1) return false
  const chunkWords = words(chunk.rawContent)
  const evidenceWords = words(evidence.evidence_text)
  if (chunkWords.length === 0 || evidenceWords.length === 0) return false
  const inChunk = new Set(chunkWords)
  const covered = evidenceWords.filter((w) => inChunk.has(w)).length / evidenceWords.length
  if (covered >= 0.5) return true
  const inEvidence = new Set(evidenceWords)
  const madeOf = chunkWords.filter((w) => inEvidence.has(w)).length / chunkWords.length
  return chunkWords.length >= 20 && madeOf >= 0.7
}
const isHit = (chunk, q) => q.evidence.some((e) => relevant(chunk, e))

// ── Retrieval ─────────────────────────────────────────────────────────────────────────────────
const byDoc = new Map(filings.map((f) => [f.doc, f]))
const allChunks = filings.flatMap((f) => f.chunks)
const hasVectors = allChunks.length > 0 && allChunks.every((c) => c.embedding?.length > 0)
const modes = ['bm25', ...(hasVectors ? ['vector', 'hybrid'] : []), ...(reranker ? ['rerank'] : [])]
const queryVectors =
  hasVectors && embeddingModel
    ? await embedTexts(
        selected.map((q) => q.question),
        embeddingModel,
        { kind: 'query', env },
      )
    : null
if (hasVectors && !queryVectors)
  console.log('chunks carry embeddings but no --embedding model was given; vector modes skipped')
const vectorModes = hasVectors && queryVectors
const activeModes = vectorModes ? modes : modes.filter((m) => m !== 'vector' && m !== 'hybrid')

async function rankOf(index, q, mode, queryVector) {
  const hits =
    mode === 'rerank'
      ? await rerank(index, q.question, {
          reranker,
          topK: 10,
          candidates: candidatesFlag ?? config.rerank.candidates,
          firstStage: firstStageFlag ?? (vectorModes ? 'hybrid' : 'bm25'),
          queryVector,
        })
      : search(index, q.question, { topK: 10, mode, queryVector })
  const found = hits.find((h) => isHit(h.chunk, q))
  return found ? found.rank : 0
}

const settings = {
  'own filing': (q) => byDoc.get(q.doc_name)?.chunks ?? [],
  'all filings': () => allChunks,
}
const indexes = { 'all filings': buildSearchIndex(allChunks) }
const perQuestion = selected.map((q) => ({
  id: q.financebench_id,
  doc: q.doc_name,
  type: q.question_type,
  question: q.question,
  reachable: (byDoc.get(q.doc_name)?.chunks ?? []).some((c) => isHit(c, q)),
  ranks: {},
}))
console.log(`\nretrieval over ${allChunks.length} chunks · modes ${activeModes.join(', ')}`)
for (const [setting, chunksFor] of Object.entries(settings)) {
  for (const [i, q] of selected.entries()) {
    const index = setting === 'all filings' ? indexes[setting] : buildSearchIndex(chunksFor(q))
    if (index.chunks.length === 0) continue
    for (const mode of activeModes) {
      const r = await rankOf(index, q, mode, queryVectors?.[i])
      perQuestion[i].ranks[`${setting}/${mode}`] = r
    }
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────────────────────
const metricsFor = (rows, key) => {
  const rs = rows.map((r) => r.ranks[key] ?? 0)
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
const table = {}
for (const setting of Object.keys(settings)) {
  table[setting] = {}
  for (const mode of activeModes) {
    const key = `${setting}/${mode}`
    table[setting][mode] = {
      all: metricsFor(perQuestion, key),
      reachable: metricsFor(
        perQuestion.filter((r) => r.reachable),
        key,
      ),
      byType: Object.fromEntries(
        ['metrics-generated', 'domain-relevant', 'novel-generated'].map((t) => [
          t,
          metricsFor(
            perQuestion.filter((r) => r.type === t),
            key,
          ),
        ]),
      ),
    }
  }
}
const processed = filings.filter((f) => !f.error)
const summary = {
  benchmark: 'FinanceBench (PatronusAI) open-source split — retrieval of the evidence chunk',
  date: new Date().toISOString(),
  version: PACKAGE_VERSION,
  platform: `${process.platform}-${process.arch}`,
  settings: {
    layout,
    embedding: embeddingModel ?? null,
    rerank: rerankPlan.id ?? null,
    firstStage: firstStageFlag ?? (vectorModes ? 'hybrid' : 'bm25'),
    candidates: candidatesFlag ?? config.rerank.candidates,
  },
  corpus: {
    filings: filings.length,
    failed: filings.filter((f) => f.error).map((f) => ({ doc: f.doc, error: f.error })),
    pages: processed.reduce((s, f) => s + f.pages, 0),
    chunks: allChunks.length,
    processMs: processed.reduce((s, f) => s + f.ms, 0),
  },
  questions: { total: selected.length, reachable: perQuestion.filter((r) => r.reachable).length },
  results: table,
  perQuestion,
}
await mkdir(join(out, '..'), { recursive: true })
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`)

const pct = (x) => `${(100 * x).toFixed(0)} %`
console.log(
  `\nfilings ${summary.corpus.filings} · pages ${summary.corpus.pages} · chunks ${summary.corpus.chunks} · processing ${(summary.corpus.processMs / 1000 / 60).toFixed(1)} min (${(summary.corpus.processMs / Math.max(1, summary.corpus.pages)).toFixed(0)} ms/page)`,
)
console.log(
  `questions ${summary.questions.total}, with the evidence present in some chunk: ${summary.questions.reachable}\n`,
)
console.log('| Setting | Mode | hit@1 | hit@5 | hit@10 | MRR | MRR (reachable) |')
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |')
for (const [setting, modesTable] of Object.entries(table)) {
  for (const [mode, m] of Object.entries(modesTable)) {
    console.log(
      `| ${setting} | ${mode} | ${pct(m.all.hitAt1)} | ${pct(m.all.hitAt5)} | ${pct(m.all.hitAt10)} | ${m.all.mrr.toFixed(3)} | ${m.reachable.mrr.toFixed(3)} |`,
    )
  }
}
console.log(`\nwritten ${out}`)
