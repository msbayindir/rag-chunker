import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { Command, Option } from 'commander'
import pc from 'picocolors'
import { findConfigFile, loadConfigFile, mergeConfigs } from '../../config/load.js'
import { localPreset } from '../../config/presets.js'
import type { RagChunkerConfig } from '../../config/schema.js'
import { readDocument, SUPPORTED_EXTENSIONS } from '../../documents/input.js'
import { RagChunkerError } from '../../errors.js'
import { PACKAGE_VERSION } from '../../output/manifest.js'
import { planDocument } from '../../pipeline/plan.js'
import { createContext, runPipeline } from '../../pipeline/process.js'
import { cliEnv } from '../env.js'
import {
  err,
  formatMs,
  formatNumber,
  header,
  out,
  ProgressRenderer,
  parseIntOption,
  reportError,
  sym,
} from '../ui.js'

export interface ProcessFlags {
  output?: string
  config?: string
  local?: boolean
  ocr?: string
  ocrPages?: 'auto' | 'all' | 'scanned'
  vision?: string
  structure?: string
  context?: string
  contextStrategy?: 'auto' | 'full' | 'hierarchical'
  embedding?: string
  maxTokens?: number
  minTokens?: number
  overlap?: number
  cache?: boolean
  layout?: boolean
  figures?: boolean
  describeFigures?: boolean
  dryRun?: boolean
  json?: boolean
  verbose?: boolean
}

export const DEFAULT_OUTPUT_DIR = 'rag-chunker-output'

/** Flags → config overrides (highest priority). */
export function flagsToConfig(flags: ProcessFlags): RagChunkerConfig {
  const cfg: RagChunkerConfig = {}
  if (flags.ocr || flags.ocrPages) cfg.ocr = { engine: flags.ocr, pages: flags.ocrPages }
  const models = {
    vision: flags.vision,
    structure: flags.structure,
    context: flags.context,
    embedding: flags.embedding,
  }
  if (Object.values(models).some(Boolean)) cfg.models = models
  if (flags.maxTokens !== undefined || flags.minTokens !== undefined || flags.overlap !== undefined) {
    cfg.chunk = { maxTokens: flags.maxTokens, minTokens: flags.minTokens, overlapTokens: flags.overlap }
  }
  if (flags.contextStrategy) cfg.context = { strategy: flags.contextStrategy }
  if (flags.cache === false) cfg.cache = { enabled: false }
  if (flags.layout === true) cfg.layout = { engine: 'pp-doclayout-v3' }
  if (flags.layout === false) cfg.layout = { engine: 'off' }
  if (flags.figures === false) cfg.figures = { extract: false }
  if (flags.describeFigures) cfg.figures = { ...cfg.figures, describe: true }
  return cfg
}

/** Expands folders (recursively) into supported files; explicit files are always kept. */
export async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === DEFAULT_OUTPUT_DIR) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (SUPPORTED_EXTENSIONS.includes(extname(e.name).toLowerCase())) files.push(full)
    }
  }
  for (const input of inputs) {
    const info = await stat(input).catch(() => null)
    if (!info) throw new RagChunkerError('INPUT_INVALID', `Not found: ${input}`)
    if (info.isDirectory()) await walk(input)
    else files.push(input)
  }
  if (files.length === 0) {
    throw new RagChunkerError('INPUT_INVALID', 'No supported documents found', {
      hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    })
  }
  return [...new Set(files.map((f) => resolve(f)))]
}

/** One output folder per document; `-o` is used as-is for a single input. */
export function outputDirs(files: string[], output: string | undefined): string[] {
  if (files.length === 1 && output) return [resolve(output)]
  const root = resolve(output ?? DEFAULT_OUTPUT_DIR)
  const used = new Map<string, number>()
  return files.map((f) => {
    const name = basename(f, extname(f)) || 'document'
    const n = (used.get(name) ?? 0) + 1
    used.set(name, n)
    return join(root, n === 1 ? name : `${name}-${n}`)
  })
}

export async function buildConfig(
  flags: ProcessFlags,
  env: Record<string, string | undefined>,
): Promise<{
  config: RagChunkerConfig
  configFile: string | undefined
}> {
  const configFile = flags.config ? resolve(flags.config) : findConfigFile()
  const fromFile = configFile ? await loadConfigFile(configFile) : undefined
  const preset = flags.local ? await localPreset(env, fromFile) : undefined
  return { config: mergeConfigs(fromFile, preset, flagsToConfig(flags)), configFile }
}

async function runDryRun(
  files: string[],
  config: RagChunkerConfig,
  env: Record<string, string | undefined>,
  json: boolean,
): Promise<void> {
  const plans = []
  for (const file of files) {
    const plan = await planDocument(file, config, { env })
    plans.push(plan)
    if (json) continue
    err(`  ${pc.bold(plan.source.name)}  ${pc.dim(`${plan.source.kind}, ${plan.pages} page(s)`)}`)
    err(
      `     OCR        ${plan.ocr.engine}${plan.ocr.pagesToOcr ? pc.dim(`  ${plan.ocr.pagesToOcr} page(s) to OCR`) : ''}`,
    )
    err(
      `     Chunks     ~${plan.estimatedChunks} ${pc.dim(`(${formatNumber(plan.documentTokens)} document tokens)`)}`,
    )
    err(
      `     Layout     ${plan.layout.engine ? `${plan.layout.engine}${plan.layout.download ? pc.dim('  (downloads the model, 130 MB)') : ''}` : pc.dim(plan.layout.reason ? `off (${plan.layout.reason})` : 'off')}`,
    )
    err(`     Headings   ${plan.structure ? plan.structure.model : pc.dim('off')}`)
    err(
      `     Context    ${plan.context ? `${plan.context.model}${pc.dim(`  ${plan.context.strategy}, ~${plan.context.estimatedRequests} request(s), ~${formatNumber(plan.context.estimatedInputTokens)} input tokens before caching`)}` : pc.dim('off')}`,
    )
    err(
      `     Embedding  ${plan.embedding ? `${plan.embedding.model}${pc.dim(`  ${plan.embedding.texts} text(s)`)}` : pc.dim('off')}`,
    )
    for (const w of plan.warnings) err(`     ${sym.warn} ${pc.yellow(w)}`)
    err()
  }
  if (json) out(JSON.stringify(plans, null, 2))
}

export async function runProcess(inputs: string[], flags: ProcessFlags): Promise<number> {
  const json = flags.json === true
  if (!json) header(PACKAGE_VERSION)
  let ctx: ReturnType<typeof createContext> | undefined
  try {
    const env = await cliEnv()
    const { config, configFile } = await buildConfig(flags, env)
    const files = await expandInputs(inputs)
    if (!json && configFile) err(`  ${sym.dot} ${pc.dim(`config: ${configFile}`)}`)

    if (flags.dryRun) {
      await runDryRun(files, config, env, json)
      return 0
    }

    ctx = createContext(config, env)
    const dirs = outputDirs(files, flags.output)
    const results: unknown[] = []
    let failures = 0

    for (let i = 0; i < files.length; i++) {
      const file = files[i] as string
      const dir = dirs[i] as string
      const renderer = new ProgressRenderer(!json, flags.verbose)
      if (!json) {
        err(`  ${pc.bold(basename(file))}${files.length > 1 ? pc.dim(`  (${i + 1}/${files.length})`) : ''}`)
      }
      try {
        const doc = await readDocument(file)
        const res = await runPipeline(doc, ctx, { onProgress: renderer.handle })
        await res.save(dir)
        renderer.stop()
        const s = res.manifest.stages.chunk
        if (json) {
          results.push({ input: file, output: dir, chunks: s.count, manifest: res.manifest })
        } else {
          err()
          err(
            `  ${pc.bold(String(s.count))} chunks ${sym.dot} avg ${s.avgTokens} tokens ${sym.dot} ${res.structure.pageCount} page(s) ${sym.dot} ${formatMs(res.manifest.durationMs)}`,
          )
          const usage = res.manifest.usage.total
          if (usage.requests > 0) {
            err(
              pc.dim(
                `  ${formatNumber(usage.requests)} model request(s) ${sym.dot} ${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out tokens${usage.cachedInputTokens ? ` ${sym.dot} ${formatNumber(usage.cachedInputTokens)} cached` : ''}`,
              ),
            )
          }
          err(`  ${pc.cyan('→')} ${dir}`)
          if (res.warnings.length > 0) {
            err(`  ${sym.warn} ${pc.yellow(`${res.warnings.length} warning(s)`)}`)
            for (const w of res.warnings.slice(0, flags.verbose ? undefined : 5)) err(`     ${pc.dim(w)}`)
            if (!flags.verbose && res.warnings.length > 5) err(pc.dim('     … run with --verbose to see all'))
          }
          const findings = res.manifest.quality?.flags ?? []
          if (findings.length > 0) {
            err(`  ${sym.dot} ${pc.bold('Quality')} ${pc.dim(`${findings.length} finding(s)`)}`)
            for (const f of findings.slice(0, flags.verbose ? undefined : 3)) err(`     ${pc.dim(f)}`)
            if (!flags.verbose && findings.length > 3)
              err(pc.dim(`     … rag-chunker inspect ${dir} shows all`))
          }
          err()
        }
      } catch (error) {
        renderer.stop()
        failures++
        if (json) results.push({ input: file, error: (error as Error).message })
        else reportError(error, flags.verbose)
        if (
          error instanceof RagChunkerError &&
          ['MISSING_API_KEY', 'QUOTA_EXCEEDED', 'CONFIG_INVALID', 'PROVIDER_UNAVAILABLE'].includes(error.code)
        ) {
          break
        }
      }
    }
    if (json) out(JSON.stringify(results, null, 2))
    return failures > 0 ? 1 : 0
  } catch (error) {
    if (json) {
      out(JSON.stringify({ error: (error as Error).message, hint: (error as RagChunkerError).hint }))
      return 1
    }
    return reportError(error, flags.verbose)
  } finally {
    await ctx?.registry.dispose()
  }
}

export function processCommand(): Command {
  const int = (name: string) => parseIntOption(name)
  return new Command('process')
    .description('Turn documents into retrieval-ready chunks')
    .argument('<inputs...>', 'PDF, DOCX, PPTX, PNG/JPEG/WebP or Markdown files, or folders')
    .option('-o, --output <dir>', `output folder (default: ./${DEFAULT_OUTPUT_DIR}/<name>)`)
    .option('-c, --config <file>', 'config file (default: ./rag-chunker.config.{json,mjs,js})')
    .option('--local', 'run every stage on Ollama (Gemma 4 vision + embeddings), nothing leaves the machine')
    .option('--ocr <engine>', 'auto | text-layer | pp-ocr (local, no keys) | mistral | <provider/model>')
    .addOption(
      new Option('--ocr-pages <mode>', 'which PDF pages go to the OCR engine').choices([
        'auto',
        'all',
        'scanned',
      ]),
    )
    .option('--vision <model>', 'vision model for scanned pages, e.g. ollama/gemma4:e4b-it-qat')
    .option('--structure <model>', 'fix heading levels with this model')
    .option('--context <model>', 'add contextual-retrieval summaries with this model')
    .addOption(new Option('--context-strategy <strategy>').choices(['auto', 'full', 'hierarchical']))
    .option('--embedding <model>', 'embed chunks with this model, e.g. ollama/embeddinggemma')
    .option('--max-tokens <n>', 'max tokens per chunk (default 512)', int('max-tokens'))
    .option('--min-tokens <n>', 'merge chunks smaller than this (default 64)', int('min-tokens'))
    .option('--overlap <n>', 'tokens of previous-chunk overlap (default 0)', int('overlap'))
    .option('--layout', 'analyse page layout with the local PP-DocLayoutV3 model (downloads 130 MB once)')
    .option('--no-layout', 'position heuristics only, no layout model')
    .option('--no-figures', 'do not cut figures out of PDF pages')
    .option('--describe-figures', 'describe every figure with the vision model (needs --vision or --local)')
    .option('--no-cache', 'do not read or write the cache')
    .option('--dry-run', 'show what would happen without calling any model')
    .option('--json', 'print a JSON summary to stdout')
    .option('--verbose', 'show every warning and stack traces')
    .addHelpText(
      'after',
      `
Examples:
  $ rag-chunker process book.pdf                       # text layer only, no keys
  $ rag-chunker process book.pdf --local               # everything on Ollama (+ local layout model)
  $ rag-chunker process paper.pdf --layout             # page layout model, no keys (downloads 130 MB once)
  $ rag-chunker process docs/ --context gemini/gemini-3.5-flash-lite --embedding gemini/gemini-embedding-001
  $ rag-chunker process scan.pdf --ocr mistral -o out/  # needs MISTRAL_API_KEY`,
    )
    .action(async (inputs: string[], flags: ProcessFlags) => {
      process.exitCode = await runProcess(inputs, flags)
    })
}
