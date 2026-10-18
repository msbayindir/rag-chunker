#!/usr/bin/env node
/**
 * The rag-chunker benchmark: real public documents, fixed question sets, repeatable numbers.
 *
 *   node scripts/bench.mjs [--only anayasa,bert] [--layout|--no-layout] [--embedding <provider/model>]
 *                          [--rerank [model]] [--label <name>] [--out bench/results]
 *
 * The PDFs are not in the repository (their licences differ); they are fetched from their original
 * addresses into bench/corpus/ and verified by sha256 (bench/corpus.json). Each document is processed
 * with the package in dist/ and evaluated with the question set in bench/questions/<name>.json:
 * BM25 always, vector/hybrid with --embedding, rerank when a reranker is downloaded or --rerank is
 * given. Results (extraction stats, quality findings, retrieval metrics) go to a JSON file and a
 * markdown table is printed.
 */
import { createHash } from 'node:crypto'
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
const only = typeof flag('--only') === 'string' ? flag('--only').split(',') : null
const label = typeof flag('--label') === 'string' ? flag('--label') : 'default'
const outDir = typeof flag('--out') === 'string' ? flag('--out') : join(root, 'bench', 'results')
const embeddingModel = typeof flag('--embedding') === 'string' ? flag('--embedding') : undefined
const rerankFlag = flag('--rerank')
const layoutFlag = args.includes('--layout') ? true : args.includes('--no-layout') ? false : undefined

const dist = (p) => import(pathToFileURL(join(root, 'dist', p)).href)
const api = await dist('index.js')
const { processDocument, resolveConfig, evaluate, createReranker, resolveReranker, readDotEnv } = api
const env = { ...(await readDotEnv().catch(() => ({}))), ...process.env }

const corpus = JSON.parse(await readFile(join(root, 'bench', 'corpus.json'), 'utf8')).documents.filter(
  (d) => !only || only.includes(d.name),
)
if (corpus.length === 0) {
  console.error('no documents selected')
  process.exit(2)
}
const corpusDir = join(root, 'bench', 'corpus')
await mkdir(corpusDir, { recursive: true })
await mkdir(outDir, { recursive: true })

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Downloads a document unless a verified copy exists. */
async function fetchDocument(doc) {
  const path = join(corpusDir, doc.file)
  if (existsSync(path) && sha256(await readFile(path)) === doc.sha256) return path
  process.stdout.write(`  fetching ${doc.file} from ${doc.url} … `)
  // Some government sites answer only browser-like clients.
  const res = await fetch(doc.url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rag-chunker-bench)', Accept: 'application/pdf,*/*' },
  })
  if (!res.ok) throw new Error(`${doc.url} → ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const hash = sha256(bytes)
  if (hash !== doc.sha256) {
    throw new Error(
      `${doc.file}: the file at ${doc.url} changed (sha256 ${hash.slice(0, 12)}…, expected ${doc.sha256.slice(0, 12)}…); update bench/corpus.json or supply the original`,
    )
  }
  await writeFile(path, bytes)
  console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
  return path
}

const config = resolveConfig({
  ...(layoutFlag === true ? { layout: { engine: 'pp-doclayout-v3' } } : {}),
  ...(layoutFlag === false ? { layout: { engine: 'off' } } : {}),
  ...(embeddingModel ? { models: { embedding: embeddingModel } } : {}),
  ocr: { engine: 'text-layer' },
})
const rerankPlan = await resolveReranker(config, rerankFlag)
const reranker = rerankPlan.id ? await createReranker(rerankPlan.id) : undefined

const results = []
const pct = (n) => `${(100 * n).toFixed(0)}%`
console.log(
  `rag-chunker bench · label ${label} · layout ${config.layout.engine} · embedding ${embeddingModel ?? 'off'} · rerank ${rerankPlan.id ?? 'off'}\n`,
)
for (const doc of corpus) {
  const path = await fetchDocument(doc)
  const t0 = Date.now()
  const res = await processDocument(path, config, { env })
  const processMs = Date.now() - t0
  const questionsPath = join(root, 'bench', 'questions', `${doc.name}.json`)
  let metrics = null
  if (existsSync(questionsPath)) {
    const set = JSON.parse(await readFile(questionsPath, 'utf8'))
    let queryVectors
    if (embeddingModel && res.chunks.every((c) => c.embedding.length > 0)) {
      const vectors = await api.embedTexts(
        set.questions.map((q) => q.question),
        embeddingModel,
        { kind: 'query', env },
      )
      queryVectors = vectors
    }
    const report = await evaluate(set, res.chunks, doc.name, queryVectors, {
      reranker,
      candidates: config.rerank.candidates,
    })
    metrics = Object.fromEntries(
      report.metrics.map((m) => [m.mode, { mrr: m.mrr, hitAt1: m.hitAt1, hitAt5: m.hitAt5 }]),
    )
  }
  const s = res.manifest.stages
  const q = res.manifest.quality
  results.push({
    name: doc.name,
    pages: s.ocr.pages,
    processMs,
    chunks: s.chunk.count,
    avgTokens: s.chunk.avgTokens,
    located: q?.chunks.located ?? 0,
    headings: q?.headings.count ?? 0,
    tables: q?.tables.count ?? 0,
    tablesBySource: q?.tables.bySource ?? {},
    figures: q?.figures.count ?? 0,
    flags: q?.flags ?? [],
    metrics,
  })
  const m = metrics ?? {}
  const best = m.rerank ?? m.hybrid ?? m.bm25
  console.log(
    `  ${doc.name.padEnd(20)} ${String(s.ocr.pages).padStart(4)} p  ${(processMs / 1000).toFixed(1).padStart(6)} s  ${String(s.chunk.count).padStart(4)} chunks  ${String(q?.headings.count ?? 0).padStart(3)} headings  ${String(q?.tables.count ?? 0).padStart(3)} tables  ${String(q?.figures.count ?? 0).padStart(3)} figures  ${best ? `MRR ${best.mrr.toFixed(3)} (${Object.keys(m).join('/')})` : ''}${q?.flags.length ? `  ⚠ ${q.flags.length}` : ''}`,
  )
}

const date = new Date().toISOString().slice(0, 10)
const file = join(outDir, `${date}-${label}.json`)
const summary = {
  date,
  label,
  version: api.PACKAGE_VERSION ?? null,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  settings: {
    layout: config.layout.engine,
    embedding: embeddingModel ?? null,
    rerank: rerankPlan.id ?? null,
    chunk: config.chunk,
  },
  results,
}
await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`)

console.log(
  `\n| Document | Pages | Time | Chunks | Headings | Tables | Figures | ${['bm25', 'hybrid', 'rerank'].map((mode) => `MRR ${mode}`).join(' | ')} |`,
)
console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`)
for (const r of results) {
  const cell = (mode) =>
    r.metrics?.[mode] ? `${r.metrics[mode].mrr.toFixed(3)} (hit@1 ${pct(r.metrics[mode].hitAt1)})` : '–'
  console.log(
    `| ${r.name} | ${r.pages} | ${(r.processMs / 1000).toFixed(1)} s | ${r.chunks} | ${r.headings} | ${r.tables} | ${r.figures} | ${cell('bm25')} | ${cell('hybrid')} | ${cell('rerank')} |`,
  )
}
console.log(`\nwritten ${file}`)
