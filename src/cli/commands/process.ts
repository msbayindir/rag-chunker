import { createInterface } from 'readline'
import { statSync } from 'fs'
import { Command } from 'commander'
import ora from 'ora'
import chalk from 'chalk'
import { process as processPdf } from '../../index.js'
import { createCliLogger } from '../../logger.js'
import { MISTRAL_MAX_BYTES } from '../../utils/pdf-splitter.js'

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question('  ' + chalk.cyan('?') + '  ' + question + chalk.dim(' [y/N] '), answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes')
    })
  })
}

const BRAND = chalk.bold('rag-chunker')
const VERSION = chalk.dim('v3.0.0')
const TAGLINE = chalk.dim('PDF  →  OCR  →  Markdown  →  Chunks')

const ok   = chalk.green('✓')
const fail = chalk.red('✗')
const warn = chalk.yellow('!')

function w(line = '') { process.stderr.write(line + '\n') }

function printHeader() {
  w()
  w('  ' + chalk.bold.cyan('◆') + '  ' + BRAND + '  ' + VERSION)
  w('  ' + ' '.repeat(5) + TAGLINE)
  w()
}

function printStep(icon: string, label: string, info: string) {
  w('  ' + icon + '  ' + chalk.bold(label.padEnd(12)) + chalk.dim(info))
}

function printSummary(opts: {
  result: Awaited<ReturnType<typeof processPdf>>
  outputDir?: string
}) {
  const { result, outputDir } = opts
  const s = result.manifest.chunkStats
  const hf = result.manifest.headingFix
  const durationS = (result.manifest.durationMs / 1000).toFixed(1) + 's'

  w()

  // ── Step list ──────────────────────────────────────────────────────────────
  const ocrExtra = result.manifest.ocrCacheHit
    ? chalk.cyan('cached') + chalk.dim('  ·  ') + chalk.dim(result.manifest.ocrModel)
    : chalk.dim(result.manifest.ocrModel)
  printStep(ok, 'OCR', `${result.structure.pageCount} pages  ·  ` + ocrExtra)

  if (hf !== null) {
    if (hf.skipped) {
      printStep(warn, 'Normalize', chalk.yellow('skipped'))
    } else {
      const hfInfo = [
        `${hf.corrections} fixes`,
        hf.documentType ? hf.documentType : null,
        hf.mainSectionsFound > 0 ? `${hf.mainSectionsFound} sections` : null,
        chalk.dim(`${(hf.phase1DurationMs / 1000).toFixed(1)}s + ${(hf.phase2DurationMs / 1000).toFixed(1)}s`)
      ].filter(Boolean).join(chalk.dim('  ·  '))
      printStep(ok, 'Normalize', hfInfo)
    }
  }

  const chunkInfo = [
    `${s.total} chunks`,
    `ø${s.avgTokens} tokens`,
    s.tableChunks > 0 ? `${s.tableChunks} tables` : null,
    s.codeChunks  > 0 ? `${s.codeChunks} code`   : null
  ].filter(Boolean).join(chalk.dim('  ·  '))
  printStep(ok, 'Chunk', chunkInfo)

  const ce = result.manifest.contextEnrichment
  if (ce !== null) {
    const ceInfo = [
      `${ce.chunksEnriched} enriched`,
      ce.chunksSkipped > 0 ? `${ce.chunksSkipped} skipped` : null,
      ce.cacheUsed ? chalk.cyan('cached') : null,
      chalk.dim(`${(ce.durationMs / 1000).toFixed(1)}s`)
    ].filter(Boolean).join(chalk.dim('  ·  '))
    printStep(ok, 'Context', ceInfo)
  }

  if (outputDir) {
    printStep(ok, 'Saved', chalk.white(outputDir + '/'))
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────
  const bar = chalk.dim('╌'.repeat(48))
  w()
  w('  ' + bar)
  w(
    '  ' +
    chalk.white.bold(String(s.total)) + chalk.dim(' chunks') +
    chalk.dim('   ·   ') +
    chalk.white.bold(String(result.structure.pageCount)) + chalk.dim(' pages') +
    chalk.dim('   ·   ') +
    chalk.white.bold(durationS)
  )
  w(
    '  ' +
    chalk.dim('tokens ') + chalk.dim(`${s.minTokens} – ${s.maxTokens}`) +
    chalk.dim('   ·   avg ') + chalk.dim(String(s.avgTokens))
  )
  w('  ' + bar)

  // ── Output files ───────────────────────────────────────────────────────────
  if (outputDir) {
    w()
    w('  ' + chalk.dim('→  ') + chalk.white(outputDir + '/'))
    w('  ' + chalk.dim('   document.md  ·  chunks.jsonl  ·  structure.json  ·  manifest.json'))
  }

  w()
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
    .option('--verbose', 'Show verbose pipeline logs')
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

      printHeader()

      // ── Large PDF check ─────────────────────────────────────────────────────
      try {
        const { size } = statSync(pdfPath)
        if (size > MISTRAL_MAX_BYTES) {
          const sizeMB = (size / 1024 / 1024).toFixed(1)
          w('  ' + chalk.yellow('!') + '  ' + chalk.yellow(`PDF is ${sizeMB} MB — exceeds Mistral's 50 MB limit`))
          w(chalk.dim('     The document will be split into 40 MB batches and processed sequentially.'))
          w(chalk.dim('     OCR results will be merged and cached as a single document.'))
          w()
          const ok = await confirm('Continue with batch processing?')
          if (!ok) {
            w()
            w('  ' + chalk.dim('Cancelled.'))
            w()
            globalThis.process.exit(0)
          }
          w()
        }
      } catch {
        // file doesn't exist — processPdf will surface a better error
      }

      if (!mistralApiKey && !geminiApiKey) {
        w(chalk.red('  ✗  No API key provided'))
        w(chalk.dim('     --mistral-api-key   or  MISTRAL_API_KEY   (primary OCR)'))
        w(chalk.dim('     --gemini-api-key    or  GEMINI_API_KEY    (context + fallback OCR)'))
        w()
        globalThis.process.exit(1)
      }

      const contextMode = opts.contextMode
      if (!['per-chunk', 'batch', 'none'].includes(contextMode)) {
        w(chalk.red('  ✗  --context-mode must be "per-chunk", "batch", or "none"'))
        globalThis.process.exit(1)
      }

      if (contextMode !== 'none' && !geminiApiKey) {
        w(chalk.red('  ✗  --gemini-api-key required for context enrichment'))
        globalThis.process.exit(1)
      }

      const spinner = ora({
        stream: process.stderr,
        prefixText: ' ',
        color: 'cyan',
        indent: 1
      }).start(chalk.dim('Initializing…'))

      const logger = createCliLogger(opts.verbose ?? false)

      const spinnerLabels: Record<string, string> = {
        'Running Mistral OCR':                  'OCR  →  scanning pages…',
        'Running Gemini Vision OCR (fallback)': 'OCR  →  Gemini Vision fallback…',
        'OCR result cached':                    'OCR  →  complete, caching…',
        'OCR cache hit':                        'OCR  →  loading from cache…',
        'Heading normalization phase 1: structure discovery': 'Normalize  →  phase 1: analyzing structure…',
        'Heading normalization phase 2: applying corrections': 'Normalize  →  phase 2: correcting headings…',
        'Chunking markdown':                    'Chunk  →  splitting document…',
        'Chunks produced':                      'Chunk  →  finalizing…',
        'Generating context summaries':         'Context  →  starting…',
        'Context cache: creating':              'Context  →  creating document cache…',
        'Context cache: ready':                 'Context  →  cache ready',
        'Context cache: unavailable — using inline text': 'Context  →  no cache, using inline text',
      }

      const trackedLogger = {
        debug: logger.debug.bind(logger),
        warn:  logger.warn.bind(logger),
        error: logger.error.bind(logger),
        info:  (msg: string, meta?: unknown) => {
          const label = spinnerLabels[msg]
          if (label) {
            spinner.text = chalk.dim(label)
          } else if (msg.startsWith('Context batch ')) {
            // e.g. "Context batch 3/26 — chunks 21–30"
            spinner.text = chalk.dim('Context  →  ' + msg)
          }
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

        spinner.stop()

        if (opts.output) {
          await result.save(opts.output)
        }

        printSummary({ result, outputDir: opts.output })

      } catch (err) {
        spinner.stop()
        w()
        w('  ' + chalk.red('✗  Processing failed'))
        w('  ' + chalk.dim('   ' + (err instanceof Error ? err.message : String(err))))
        w()
        globalThis.process.exit(1)
      }
    })
}
