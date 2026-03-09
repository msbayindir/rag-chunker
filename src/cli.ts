#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs'
import { parseArgs } from 'util'
import { chunk } from './index.js'

const HELP = `
Usage: rag-chunker <pdf> [options]

Options:
  --api-key,       -k  Gemini API key (default: GEMINI_API_KEY env)
  --model,         -m  Gemini model (default: gemini-2.0-flash)
  --chunk-model        Model for chunk determination
  --context-model      Model for context summaries
  --output,        -o  Output JSON file (default: stdout)
  --group-size         Pages per group (default: 15)
  --max-pages          Max pages to process
  --skip-context       Skip context summary generation
  --context-mode       per-chunk | batch (default: per-chunk)
  --batch-size         Chunks per batch in batch mode (default: 10)
  --no-registry        Disable cache registry
  --registry           Custom registry JSON path
  --timeout            Timeout in milliseconds
  --pretty             Pretty-print JSON output
  --help,          -h  Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'api-key':      { type: 'string',  short: 'k' },
    'model':        { type: 'string',  short: 'm' },
    'chunk-model':  { type: 'string' },
    'context-model':{ type: 'string' },
    'output':       { type: 'string',  short: 'o' },
    'group-size':   { type: 'string' },
    'max-pages':    { type: 'string' },
    'skip-context': { type: 'boolean' },
    'context-mode': { type: 'string' },
    'batch-size':   { type: 'string' },
    'no-registry':  { type: 'boolean' },
    'registry':     { type: 'string' },
    'timeout':      { type: 'string' },
    'pretty':       { type: 'boolean' },
    'help':         { type: 'boolean', short: 'h' },
  }
})

if (values['help'] || positionals.length === 0) {
  process.stdout.write(HELP)
  process.exit(positionals.length === 0 && !values['help'] ? 1 : 0)
}

const pdfPath = positionals[0]!
const apiKey  = values['api-key'] ?? process.env['GEMINI_API_KEY']

if (!apiKey) {
  process.stderr.write('Error: Gemini API key required (--api-key or GEMINI_API_KEY env)\n')
  process.exit(1)
}

let pdfBuffer: Buffer
try {
  pdfBuffer = readFileSync(pdfPath)
} catch {
  process.stderr.write(`Error: Cannot read file: ${pdfPath}\n`)
  process.exit(1)
}

const contextMode = values['context-mode']
if (contextMode && contextMode !== 'per-chunk' && contextMode !== 'batch') {
  process.stderr.write(`Error: --context-mode must be "per-chunk" or "batch"\n`)
  process.exit(1)
}

// Progress display on stderr (keeps stdout clean for JSON piping)
const stages: Record<string, string> = {
  upload:  'Uploading PDF',
  cache:   'Creating cache',
  chunk:   'Chunking pages',
  context: 'Generating context',
}
let lastStage = ''

function showProgress(stage: string, done: number, total: number): void {
  if (stage !== lastStage) {
    if (lastStage) process.stderr.write('\n')
    lastStage = stage
  }
  const label = stages[stage] ?? stage
  const bar = `[${'█'.repeat(Math.round((done / total) * 20))}${'░'.repeat(20 - Math.round((done / total) * 20))}]`
  process.stderr.write(`\r${label} ${bar} ${done}/${total}`)
}

;(async () => {
  try {
    const result = await chunk(pdfBuffer, {
      geminiApiKey:     apiKey,
      geminiModel:      values['model'],
      chunkModel:       values['chunk-model'],
      contextModel:     values['context-model'],
      groupSize:        values['group-size']  ? parseInt(values['group-size'],  10) : undefined,
      maxPages:         values['max-pages']   ? parseInt(values['max-pages'],   10) : undefined,
      skipContext:      values['skip-context'],
      contextMode:      contextMode as 'per-chunk' | 'batch' | undefined,
      contextBatchSize: values['batch-size']  ? parseInt(values['batch-size'],  10) : undefined,
      cacheRegistry:    values['no-registry'] ? false : (values['registry'] ?? undefined),
      timeoutMs:        values['timeout']     ? parseInt(values['timeout'],     10) : undefined,
      onProgress: ({ stage, done, total }) => showProgress(stage, done, total),
    })

    if (lastStage) process.stderr.write('\n')

    const success = result.chunks.filter(c => c.status === 'success').length
    const partial = result.chunks.filter(c => c.status === 'partial').length
    const errors  = result.chunks.filter(c => c.status === 'error' || c.status === 'timeout').length

    process.stderr.write(
      `\nDone: ${result.chunks.length} chunks | ${result.totalPages} pages | ` +
      `${(result.durationMs / 1000).toFixed(1)}s | ` +
      `success=${success} partial=${partial} errors=${errors}\n`
    )

    const json = values['pretty']
      ? JSON.stringify(result, null, 2)
      : JSON.stringify(result)

    if (values['output']) {
      writeFileSync(values['output'], json, 'utf-8')
      process.stderr.write(`Output written to: ${values['output']}\n`)
    } else {
      process.stdout.write(json + '\n')
    }
  } catch (err) {
    if (lastStage) process.stderr.write('\n')
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
})()
