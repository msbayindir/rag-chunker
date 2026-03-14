import { Command } from 'commander'
import ora from 'ora'
import type { ProgressEvent } from '../../types.js'
import { process as processPdf } from '../../process.js'

export function buildProcessCommand(): Command {
  return new Command('process')
    .description('Process a PDF into chunks, markdown, structure, and manifest')
    .argument('<pdf>', 'Path to the PDF file')
    .option('-o, --output <dir>', 'Output directory (writes document.md, structure.json, chunks.jsonl, manifest.json)')
    .option('-k, --gemini-api-key <key>', 'Gemini API key (default: GEMINI_API_KEY env)')
    .option('--parser <mode>', 'Parse strategy: vision-only | hybrid | local-only', 'vision-only')
    .option('--chunk-model <model>', 'Model for chunk determination')
    .option('--context-model <model>', 'Model for context summaries')
    .option('--model <model>', 'Default Gemini model for all steps')
    .option('--context-mode <mode>', 'per-chunk | batch', 'per-chunk')
    .option('--context-batch-size <n>', 'Chunks per batch in batch mode', '10')
    .option('--skip-context', 'Skip context summary generation')
    .option('--chunking-strategy <strategy>', 'structure-aware | semantic', 'structure-aware')
    .option('--max-chunk-tokens <n>', 'Max tokens per chunk (structure-aware)', '512')
    .option('--group-size <n>', 'Pages per vision group', '15')
    .option('--triage-threshold <n>', 'Hybrid triage threshold (0-1)', '0.7')
    .option('--no-registry', 'Disable cache registry')
    .option('--registry <path>', 'Custom registry JSON path')
    .option('--timeout <ms>', 'Timeout in milliseconds')
    .action(async (pdfPath: string, opts: {
      output?: string
      geminiApiKey?: string
      parser?: string
      chunkModel?: string
      contextModel?: string
      model?: string
      contextMode?: string
      contextBatchSize?: string
      skipContext?: boolean
      chunkingStrategy?: string
      maxChunkTokens?: string
      groupSize?: string
      triageThreshold?: string
      registry?: boolean | string
      timeout?: string
    }) => {
      const apiKey = opts.geminiApiKey ?? globalThis.process.env['GEMINI_API_KEY']

      if (!apiKey) {
        process.stderr.write('Error: Gemini API key required (--gemini-api-key or GEMINI_API_KEY env)\n')
        globalThis.process.exit(1)
      }

      const contextMode = opts.contextMode
      if (contextMode && contextMode !== 'per-chunk' && contextMode !== 'batch') {
        process.stderr.write('Error: --context-mode must be "per-chunk" or "batch"\n')
        globalThis.process.exit(1)
      }

      const parser = opts.parser
      if (parser && !['vision-only', 'hybrid', 'local-only'].includes(parser)) {
        process.stderr.write('Error: --parser must be "vision-only", "hybrid", or "local-only"\n')
        globalThis.process.exit(1)
      }

      const chunkingStrategy = opts.chunkingStrategy
      if (chunkingStrategy && !['structure-aware', 'semantic'].includes(chunkingStrategy)) {
        process.stderr.write('Error: --chunking-strategy must be "structure-aware" or "semantic"\n')
        globalThis.process.exit(1)
      }

      // Progress spinner
      const spinner = ora({ stream: process.stderr }).start('Starting...')
      const stages: Record<string, string> = {
        upload: 'Uploading PDF',
        cache: 'Creating cache',
        chunk: 'Parsing pages',
        context: 'Generating context'
      }

      const stageCompleted: Record<string, boolean> = {}

      function onProgress(event: ProgressEvent): void {
        const label = stages[event.stage] ?? event.stage
        if (event.done < event.total) {
          spinner.text = `${label}... [${event.done}/${event.total}]`
        } else {
          if (!stageCompleted[event.stage]) {
            stageCompleted[event.stage] = true
            spinner.succeed(`${label} complete`)
            spinner.start('...')
          }
        }
      }

      try {
        const result = await processPdf(pdfPath, {
          geminiApiKey: apiKey,
          geminiModel: opts.model,
          chunkModel: opts.chunkModel,
          contextModel: opts.contextModel,
          parser: parser as 'vision-only' | 'hybrid' | 'local-only' | undefined,
          contextMode: contextMode as 'per-chunk' | 'batch' | undefined,
          contextBatchSize: opts.contextBatchSize ? parseInt(opts.contextBatchSize, 10) : undefined,
          skipContext: opts.skipContext,
          chunkingStrategy: chunkingStrategy as 'structure-aware' | 'semantic' | undefined,
          maxChunkTokens: opts.maxChunkTokens ? parseInt(opts.maxChunkTokens, 10) : undefined,
          groupSize: opts.groupSize ? parseInt(opts.groupSize, 10) : undefined,
          triageThreshold: opts.triageThreshold ? parseFloat(opts.triageThreshold) : undefined,
          cacheRegistry: opts.registry === false ? false : (typeof opts.registry === 'string' ? opts.registry : undefined),
          timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
          outputDir: opts.output,
          onProgress
        })

        spinner.stop()

        const totalChunks = result.chunks.length
        const { duration_ms } = result.manifest

        process.stderr.write(
          `\n✓ Done: ${totalChunks} chunks | ${result.manifest.input.page_count} pages | ${(duration_ms / 1000).toFixed(1)}s\n`
        )

        if (opts.output) {
          process.stderr.write(`\nOutput files written to: ${opts.output}/\n`)
          process.stderr.write(`  - document.md (${(result.markdown.length / 1024).toFixed(1)} KB)\n`)
          process.stderr.write(`  - structure.json\n`)
          process.stderr.write(`  - chunks.jsonl (${totalChunks} chunks)\n`)
          process.stderr.write(`  - manifest.json\n`)
        }
      } catch (err) {
        spinner.fail('Processing failed')
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
        globalThis.process.exit(1)
      }
    })
}
