// node examples/basic.mjs document.pdf
import { processDocument } from '@msbayindir/rag-chunker'

const file = process.argv[2]
if (!file) throw new Error('usage: node basic.mjs <file>')

// No models configured: text layer + chunker only, no network calls.
const result = await processDocument(file)
for (const chunk of result.chunks) {
  console.log(`#${chunk.index} p${chunk.pageStart}-${chunk.pageEnd} ${chunk.sectionPath.join(' › ')}`)
  console.log(chunk.rawContent.slice(0, 160).replace(/\n/g, ' '), '\n')
}
console.log(result.warnings.join('\n'))
