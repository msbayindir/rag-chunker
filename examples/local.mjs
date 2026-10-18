// ollama pull gemma4:e4b-it-qat && ollama pull embeddinggemma
// node examples/local.mjs document.pdf "your question"
import { buildSearchIndex, embedQuery, localPreset, processDocument, search } from '@msbayindir/rag-chunker'

const [file, question = 'What is this document about?'] = process.argv.slice(2)
const config = await localPreset(process.env) // picks the best installed Gemma 4 for this machine
const result = await processDocument(file, config, {
  onProgress: (e) => e.type === 'stage-end' && !e.skipped && console.error(`✓ ${e.stage} ${e.detail ?? ''}`),
})
await result.save('out')

const index = buildSearchIndex(result.chunks)
const queryVector = await embedQuery(question, config.models.embedding)
for (const hit of search(index, question, { topK: 3, queryVector })) {
  console.log(`\n#${hit.rank} (page ${hit.chunk.pageStart}) ${hit.chunk.contextSummary}`)
  console.log(hit.chunk.rawContent.slice(0, 300))
}
