import { Command } from 'commander'
import { readFileSync } from 'fs'
import { chunkMarkdown } from '../../chunker/ast-chunker.js'

export function buildChunkCommand(): Command {
  return new Command('chunk')
    .description('Chunk a markdown file and print chunk boundaries (no API keys needed)')
    .argument('<md>', 'Path to a markdown file')
    .option('--max-tokens <n>', 'Max tokens per chunk', '512')
    .option('--min-tokens <n>', 'Min tokens for a chunk to be emitted', '50')
    .option('--overlap-tokens <n>', 'Tokens of overlap from the previous chunk', '0')
    .option('--no-preserve-tables', 'Do not keep tables in their own chunk')
    .option('--no-preserve-code', 'Do not keep code blocks in their own chunk')
    .action((mdPath: string, opts: {
      maxTokens: string
      minTokens: string
      overlapTokens: string
      preserveTables: boolean
      preserveCode: boolean
    }) => {
      let markdown: string
      try {
        markdown = readFileSync(mdPath, 'utf-8')
      } catch {
        process.stderr.write(`Error: Cannot read file: ${mdPath}\n`)
        globalThis.process.exit(1)
      }

      const chunks = chunkMarkdown(markdown, {
        maxChunkTokens: parseInt(opts.maxTokens, 10),
        minChunkTokens: parseInt(opts.minTokens, 10),
        overlapTokens: parseInt(opts.overlapTokens, 10),
        preserveTables: opts.preserveTables,
        preserveCodeBlocks: opts.preserveCode
      })

      process.stdout.write(`Total chunks: ${chunks.length}\n\n`)

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!
        const header = [
          `Chunk ${i + 1}`,
          c.contentType,
          `${c.tokenCount} tokens`,
          `page ${c.pageNumber}`,
          c.mustPreserve ? 'preserved' : ''
        ].filter(Boolean).join(' | ')

        process.stdout.write(`--- ${header} ---\n`)

        if (c.sectionPath.length > 0) {
          process.stdout.write(`Section: ${c.sectionPath.join(' > ')}\n`)
        }

        const preview = c.content.length > 200
          ? c.content.slice(0, 200) + '...'
          : c.content
        process.stdout.write(preview)
        process.stdout.write('\n\n')
      }
    })
}
