import { Command } from 'commander'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export function buildInspectCommand(): Command {
  return new Command('inspect')
    .description('Inspect an output directory (reads manifest.json and structure.json)')
    .argument('<output-dir>', 'Path to the output directory produced by `rag-chunker process`')
    .action((outputDir: string) => {
      const manifestPath = join(outputDir, 'manifest.json')
      const structurePath = join(outputDir, 'structure.json')

      if (!existsSync(manifestPath)) {
        process.stderr.write(`Error: No manifest.json found in: ${outputDir}\n`)
        globalThis.process.exit(1)
      }

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>

        process.stdout.write('\n')
        process.stdout.write(`Version:       ${manifest['version']}\n`)
        process.stdout.write(`Processed:     ${manifest['processedAt']}\n`)
        process.stdout.write(`PDF hash:      ${String(manifest['pdfHash']).slice(0, 12)}…\n`)
        process.stdout.write(`OCR model:     ${manifest['ocrModel']}\n`)
        process.stdout.write(`Context model: ${manifest['contextModel']}\n`)
        process.stdout.write(`Context mode:  ${manifest['contextMode']}\n`)
        process.stdout.write(`OCR cache hit: ${manifest['ocrCacheHit']}\n`)
        process.stdout.write(`Duration:      ${(Number(manifest['durationMs']) / 1000).toFixed(2)}s\n`)

        const s = manifest['chunkStats'] as Record<string, number> | undefined
        if (s) {
          process.stdout.write('\nChunks:\n')
          process.stdout.write(`  total:  ${s['total']}\n`)
          process.stdout.write(`  avg:    ${s['avgTokens']} tokens\n`)
          process.stdout.write(`  range:  ${s['minTokens']}–${s['maxTokens']} tokens\n`)
          process.stdout.write(
            `  types:  text=${s['textChunks']}  table=${s['tableChunks']}  ` +
            `code=${s['codeChunks']}  mixed=${s['mixedChunks']}\n`
          )
        }

        if (existsSync(structurePath)) {
          const structure = JSON.parse(readFileSync(structurePath, 'utf-8')) as Record<string, unknown>
          process.stdout.write('\nDocument structure:\n')
          process.stdout.write(`  pages:       ${structure['pageCount']}\n`)
          process.stdout.write(
            `  headings:    ${(structure['headings'] as unknown[])?.length ?? 0}\n`
          )
          process.stdout.write(`  tables:      ${structure['tableCount']}\n`)
          process.stdout.write(`  code blocks: ${structure['codeBlockCount']}\n`)
          process.stdout.write(`  total tokens: ${structure['totalTokens']}\n`)
        }

        process.stdout.write('\n')
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
        globalThis.process.exit(1)
      }
    })
}
