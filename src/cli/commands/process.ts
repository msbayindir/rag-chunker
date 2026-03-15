import { Command } from 'commander'
import ora from 'ora'
import chalk from 'chalk'
import { process as processPdf } from '../../index.js'
import { createCliLogger } from '../../logger.js'

function printSummary(opts: {
  chunks: number
  pages: number
  avgTokens: number
  minTokens: number
  maxTokens: number
  tableChunks: number
  codeChunks: number
  durationMs: number
  ocrModel: string
  contextMode: string
  ocrCacheHit: boolean
  outputDir?: string
}): void {
  const w = 42
  const line = chalk.dim('─'.repeat(w))
  const pad = (label: string, value: string) => {
    const gap = w - 2 - label.length - value.length
    return ' ' + label + ' '.repeat(Math.max(1, gap)) + chalk.white(value)
  }

  process.stderr.write('\n')
  process.stderr.write(chalk.dim('─'.repeat(w)) + '\n')
  process.stderr.write(pad('Chunks',      String(opts.chunks)) + '\n')
  process.stderr.write(pad('Pages',       String(opts.pages)) + '\n')
  process.stderr.write(pad('Avg tokens',  String(opts.avgTokens)) + '\n')
  process.stderr.write(pad('Token range', `${opts.minTokens} – ${opts.maxTokens}`) + '\n')
  if (opts.tableChunks > 0)
    process.stderr.write(pad('Table chunks', String(opts.tableChunks)) + '\n')
  if (opts.codeChunks > 0)
    process.stderr.write(pad('Code chunks',  String(opts.codeChunks)) + '\n')
  process.stderr.write(pad('OCR model',   opts.ocrModel) + '\n')
  process.stderr.write(pad('Context',     opts.contextMode) + '\n')
  process.stderr.write(pad('OCR cache',   opts.ocrCacheHit ? chalk.green('hit') : chalk.dim('miss')) + '\n')
  process.stderr.write(pad('Duration',    (opts.durationMs / 1000).toFixed(1) + 's') + '\n')
  process.stderr.write(line + '\n')

  if (opts.outputDir) {
    process.stderr.write('\n')
    process.stderr.write(chalk.dim('  Output → ') + chalk.white(opts.outputDir + '/') + '\n')
    process.stderr.write(chalk.dim('    document.md  structure.json  chunks.jsonl  manifest.json') + '\n')
  }

  process.stderr.write('\n')
}

export function buildProcessCommand(): Command {
  return new Command('process')
    .description('Process a PDF into chunks, markdown, structure, and manifest')
    .argument('<pdf>', 'Path to the PDF file')
    .option('-o, --output <dir>', 'Output directory')
    .option(
      '-k, --gemini-api-key <key>',
      'Gemini API key — context enrichment & fallback OCR (default: GEMINI_API_KEY env)'
    )
    .option(
      '-m, --mistral-api-key <key>',
      'Mistral API key — primary OCR provider (default: MISTRAL_API_KEY env)'
    )
    .option('--context-mode <mode>', 'Context mode: per-chunk | batch | none', 'none')
    .option('--context-model <model>', 'Gemini model for context summaries')
    .option('--context-batch-size <n>', 'Chunks per batch in batch mode', '10')
    .option('--max-chunk-tokens <n>', 'Max tokens per chunk', '512')
    .option('--min-chunk-tokens <n>', 'Min tokens per chunk', '50')
    .option('--overlap-tokens <n>', 'Overlap tokens prepended from previous chunk', '0')
    .option('--no-preserve-tables', 'Do not keep tables in their own chunk')
    .option('--no-preserve-code', 'Do not keep code blocks in their own chunk')
    .option('--ocr-cache-path <path>', 'Custom OCR cache JSON path')
    .option('--ocr-cache-ttl <days>', 'OCR cache TTL in days', '7')
    .option('--no-ocr-cache', 'Disable OCR caching')
    .option('--heading-normalization', 'Fix inconsistent heading levels via Gemini (requires --gemini-api-key)')
    .option('--warn-large-chunk <n>', 'Warn when a table/code chunk exceeds N tokens', '2000')
    .option('--verbose', 'Show debug log messages')
    .action(async (pdfPath: string, opts: {
      output?: string
      geminiApiKey?: string
      mistralApiKey?: string
      contextMode: string
      contextModel?: string
      contextBatchSize: string
      maxChunkTokens: string
      minChunkTokens: string
      overlapTokens: string
      preserveTables: boolean
      preserveCode: boolean
      ocrCachePath?: string
      ocrCacheTtl: string
      ocrCache: boolean
      headingNormalization?: boolean
      warnLargeChunk: string
      verbose?: boolean
    }) => {
      const geminiApiKey = opts.geminiApiKey ?? globalThis.process.env['GEMINI_API_KEY']
      const mistralApiKey = opts.mistralApiKey ?? globalThis.process.env['MISTRAL_API_KEY']

      if (!mistralApiKey && !geminiApiKey) {
        process.stderr.write(
          chalk.red('\n  ✖ API key required\n') +
          chalk.dim('    --mistral-api-key or MISTRAL_API_KEY  (primary OCR)\n') +
          chalk.dim('    --gemini-api-key  or GEMINI_API_KEY   (context + fallback OCR)\n\n')
        )
        globalThis.process.exit(1)
      }

      const contextMode = opts.contextMode
      if (!['per-chunk', 'batch', 'none'].includes(contextMode)) {
        process.stderr.write(chalk.red('  ✖ --context-mode must be "per-chunk", "batch", or "none"\n'))
        globalThis.process.exit(1)
      }

      if (contextMode !== 'none' && !geminiApiKey) {
        process.stderr.write(chalk.red('  ✖ --gemini-api-key required for context enrichment\n'))
        globalThis.process.exit(1)
      }

      process.stderr.write('\n')
      process.stderr.write(chalk.bold('  rag-chunker') + chalk.dim(' v3.0.0\n'))
      process.stderr.write('\n')

      const spinner = ora({
        stream: process.stderr,
        prefixText: ' ',
        color: 'cyan'
      }).start(chalk.dim('Initializing...'))

      const logger = createCliLogger(opts.verbose ?? false)

      // Intercept logger to update spinner text
      const trackedLogger = {
        debug: logger.debug.bind(logger),
        warn:  logger.warn.bind(logger),
        error: logger.error.bind(logger),
        info:  (msg: string, meta?: unknown) => {
          const labels: Record<string, string> = {
            'Running Mistral OCR':            'Running Mistral OCR 3...',
            'Running Gemini Vision OCR (fallback)': 'Running Gemini Vision OCR...',
            'OCR result cached':              'OCR complete — caching result',
            'OCR cache hit':                  'OCR cache hit — skipping API call',
            'Chunking markdown':              'Chunking document...',
            'Chunks produced':                (() => {
              const count = (meta as Record<string, unknown>)?.['count']
              return count != null ? `Chunking complete — ${count} chunks` : 'Chunks produced'
            })(),
            'Generating context summaries':   'Generating context summaries...',
          }
          const label = labels[msg]
          if (label) spinner.text = chalk.dim(label)
          if (opts.verbose) logger.info(msg, meta)
        }
      }

      try {
        const result = await processPdf(pdfPath, {
          geminiApiKey,
          mistralApiKey,
          contextMode: contextMode as 'per-chunk' | 'batch' | 'none',
          contextModel: opts.contextModel,
          contextBatchSize: parseInt(opts.contextBatchSize, 10),
          maxChunkTokens: parseInt(opts.maxChunkTokens, 10),
          minChunkTokens: parseInt(opts.minChunkTokens, 10),
          overlapTokens: parseInt(opts.overlapTokens, 10),
          preserveTables: opts.preserveTables,
          preserveCodeBlocks: opts.preserveCode,
          ocrCachePath: opts.ocrCache ? (opts.ocrCachePath ?? undefined) : false,
          ocrCacheTtlDays: parseFloat(opts.ocrCacheTtl),
          headingNormalization: opts.headingNormalization ?? false,
          warnLargeChunkTokens: parseInt(opts.warnLargeChunk, 10),
          logger: trackedLogger
        })

        spinner.succeed(chalk.green('Done'))

        if (opts.output) {
          await result.save(opts.output)
        }

        const s = result.manifest.chunkStats
        printSummary({
          chunks:      s.total,
          pages:       result.structure.pageCount,
          avgTokens:   s.avgTokens,
          minTokens:   s.minTokens,
          maxTokens:   s.maxTokens,
          tableChunks: s.tableChunks,
          codeChunks:  s.codeChunks,
          durationMs:  result.manifest.durationMs,
          ocrModel:    result.manifest.ocrModel,
          contextMode: result.manifest.contextMode,
          ocrCacheHit: result.manifest.ocrCacheHit,
          outputDir:   opts.output
        })
      } catch (err) {
        spinner.fail(chalk.red('Processing failed'))
        process.stderr.write(chalk.red('\n  ' + (err instanceof Error ? err.message : String(err))) + '\n\n')
        globalThis.process.exit(1)
      }
    })
}
