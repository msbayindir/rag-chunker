// node examples/search-with-reranker.mjs out "your question"
//
// Two-stage search over an output folder written by `rag-chunker process`: keyword (or hybrid,
// when the chunks carry embeddings and the same model is available) search picks 30 candidates,
// a local cross-encoder reorders them. The profile's reranker (570 MB with the default `full` profile,
// 120 MB with `basic`) is downloaded on first use.
import {
  buildSearchIndex,
  createReranker,
  embedQuery,
  readOutputDir,
  rerank,
  resolveConfig,
  resolveReranker,
  search,
} from '@msbayindir/rag-chunker'

const [dir = 'out', question = 'What is this document about?'] = process.argv.slice(2)
const output = await readOutputDir(dir)
const index = buildSearchIndex(output.chunks)

// Hybrid first stage when the folder has embeddings (the manifest names the model).
const embeddingModel = output.manifest.stages.embedding?.model
const queryVector =
  embeddingModel && index.hasVectors ? await embedQuery(question, embeddingModel) : undefined

// `auto` uses the local model once downloaded; `true` downloads it now.
const plan = await resolveReranker(resolveConfig({}), true)
const reranker = plan.id ? await createReranker(plan.id) : undefined

const hits = reranker
  ? await rerank(index, question, { reranker, topK: 5, candidates: 30, queryVector })
  : search(index, question, { topK: 5, queryVector })

console.log(
  `${reranker ? `reranked by ${reranker.id}` : 'first stage only'} (${queryVector ? 'hybrid' : 'bm25'} candidates)\n`,
)
for (const hit of hits) {
  const c = hit.chunk
  console.log(`#${hit.rank} score ${hit.score.toFixed(3)}  p${c.pageStart}  ${c.sectionPath.join(' › ')}`)
  console.log(`   ${c.rawContent.slice(0, 200).replace(/\n/g, ' ')}\n`)
}
