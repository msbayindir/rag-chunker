// MISTRAL_API_KEY and GEMINI_API_KEY in the environment; Ollama running with embeddinggemma.
import { processDocument } from '@msbayindir/rag-chunker'

const result = await processDocument(
  process.argv[2],
  {
    ocr: { engine: 'mistral' },
    models: {
      structure: 'gemini/gemini-3.8-flash',
      context: 'gemini/gemini-3.5-flash-lite',
      embedding: 'ollama/embeddinggemma',
    },
    chunk: { maxTokens: 400, overlapTokens: 40 },
  },
  {
    onProgress: (e) => {
      if (e.type === 'progress') process.stderr.write(`\r${e.stage} ${e.done}/${e.total}   `)
      if (e.type === 'warning') console.warn(`\n! ${e.message}`)
    },
  },
)
await result.save('out')
console.log(`\n${result.chunks.length} chunks`, result.manifest.usage.total)
