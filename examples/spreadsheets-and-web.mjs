// node examples/spreadsheets-and-web.mjs budget.xlsx page.html
//
// Spreadsheets and HTML pages go through the same chunker as PDFs: every visible sheet is a page
// whose blocks of cells become GFM tables; an HTML page keeps its main content (no navigation,
// scripts or site chrome). No models, no network.
import { processDocument } from '@msbayindir/rag-chunker'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('usage: node spreadsheets-and-web.mjs <file.xlsx|file.html> …')

for (const file of files) {
  const result = await processDocument(file)
  console.log(`\n${file}: ${result.chunks.length} chunk(s), ${result.structure.pageCount} page(s)`)
  for (const chunk of result.chunks) {
    const where =
      chunk.pageStart === chunk.pageEnd ? `p${chunk.pageStart}` : `p${chunk.pageStart}-${chunk.pageEnd}`
    console.log(`  #${chunk.index} ${where} [${chunk.contentType}] ${chunk.sectionPath.join(' › ')}`)
  }
  // A sheet's tables arrive as table chunks whose header row repeats when a table is split.
  const first = result.chunks.find((c) => c.contentType === 'table') ?? result.chunks[0]
  if (first) console.log(`\n${first.rawContent.split('\n').slice(0, 6).join('\n')}`)
}
