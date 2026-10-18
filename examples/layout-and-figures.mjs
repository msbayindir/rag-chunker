// node examples/layout-and-figures.mjs paper.pdf [ollama/gemma4:e4b-it-qat]
//
// Local page layout analysis (PP-DocLayoutV3 + SLANet_plus, downloaded once, 138 MB) plus the
// figures of the pages cut out as PNG files. With a vision model as the second argument, every
// figure also gets a short description that becomes searchable text under the image.
import { processDocument } from '@msbayindir/rag-chunker'

const [file, vision] = process.argv.slice(2)
if (!file) throw new Error('usage: node layout-and-figures.mjs <pdf> [provider/vision-model]')

const result = await processDocument(
  file,
  {
    layout: { engine: 'pp-doclayout-v3' }, // "auto" would use it only once it is downloaded
    figures: { extract: true, describe: Boolean(vision) },
    ...(vision ? { models: { vision } } : {}),
  },
  {
    onProgress: (e) => {
      if (e.type === 'progress' && e.detail?.startsWith('downloading'))
        console.error(`  ${e.detail} ${e.done}/${e.total}`)
      if (e.type === 'stage-end' && !e.skipped) console.error(`✓ ${e.stage} ${e.detail ?? ''}`)
    },
  },
)
const paths = await result.save('out')

// document.json: every block with its class, position, table structure or figure file.
for (const page of result.layout.pages) {
  for (const block of page.blocks) {
    if (block.kind === 'table' && block.table) {
      console.log(`p${page.number} table ${block.table.rows}×${block.table.cols} (${block.table.source})`)
    } else if (block.kind === 'figure' && block.figure) {
      console.log(`p${page.number} figure ${block.figure.file}: ${block.figure.caption ?? '(no caption)'}`)
      if (block.figure.description) console.log(`   ${block.figure.description.slice(0, 200)}…`)
    }
  }
}
console.log(`\n${result.figures.length} figure(s) written under ${paths.figures ?? '(none)'}`)
// The quality report says what deserves a look (scanned pages, sparse tables, odd headings…).
for (const flag of result.manifest.quality?.flags ?? []) console.log(`⚠ ${flag}`)
