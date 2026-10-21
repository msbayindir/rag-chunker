import ora, { type Ora } from 'ora'
import pc from 'picocolors'
import { RagChunkerError } from '../errors.js'
import type { ProgressEvent, Stage } from '../pipeline/events.js'

export const sym = {
  ok: pc.green('✓'),
  warn: pc.yellow('!'),
  fail: pc.red('✗'),
  skip: pc.dim('–'),
  dot: pc.dim('·'),
  arrow: pc.cyan('›'),
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`)
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

export function header(version: string): void {
  err()
  err(`  ${pc.bold(pc.cyan('◆'))}  ${pc.bold('rag-chunker')} ${pc.dim(`v${version}`)}`)
  err()
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

const STAGE_LABEL: Record<Stage, string> = {
  read: 'Read',
  ocr: 'OCR',
  structure: 'Headings',
  chunk: 'Chunk',
  context: 'Context',
  embedding: 'Embed',
  write: 'Save',
}

/** Renders pipeline progress events as a spinner plus one line per finished stage. */
export class ProgressRenderer {
  private spinner: Ora | null = null
  private started = new Map<Stage, number>()
  readonly warnings: string[] = []

  constructor(
    private readonly enabled: boolean,
    private readonly verbose = false,
  ) {}

  handle = (e: ProgressEvent): void => {
    if (e.type === 'warning') {
      this.warnings.push(e.message)
      if (this.verbose) this.print(`  ${sym.warn}  ${pc.yellow(e.message)}`)
      return
    }
    if (!this.enabled) return
    if (e.type === 'stage-start') {
      this.started.set(e.stage, Date.now())
      if (e.stage === 'read' || e.stage === 'write') return
      this.spin(`${STAGE_LABEL[e.stage]}${e.detail ? pc.dim(`  ${e.detail}`) : ''}`)
    } else if (e.type === 'progress') {
      const pct = e.total > 0 ? Math.floor((e.done / e.total) * 100) : 0
      this.spin(
        `${STAGE_LABEL[e.stage]}  ${e.done}/${e.total} ${pc.dim(`(${pct}%)${e.detail ? `  ${e.detail}` : ''}`)}`,
      )
    } else if (e.type === 'stage-end') {
      if (e.stage === 'read' || e.stage === 'write') return
      const took = Date.now() - (this.started.get(e.stage) ?? Date.now())
      const icon = e.skipped ? sym.skip : sym.ok
      const label = STAGE_LABEL[e.stage].padEnd(9)
      const detail = e.skipped
        ? pc.dim(e.detail ?? 'skipped')
        : `${e.detail ?? ''}  ${pc.dim(formatMs(took))}`
      if (e.skipped && !this.verbose) {
        this.stopSpinner()
        return
      }
      this.print(`  ${icon}  ${pc.bold(label)} ${detail}`)
    }
  }

  private spin(text: string): void {
    if (!process.stderr.isTTY) return
    if (!this.spinner) this.spinner = ora({ stream: process.stderr, indent: 2, color: 'cyan' }).start(text)
    else this.spinner.text = text
  }

  private stopSpinner(): void {
    this.spinner?.stop()
    this.spinner = null
  }

  print(line: string): void {
    this.stopSpinner()
    err(line)
  }

  stop(): void {
    this.stopSpinner()
  }
}

/** Prints an error with its hint and returns the exit code. */
export const ISSUES_URL = 'https://github.com/msbayindir/rag-chunker/issues/new/choose'
export const DISCUSSIONS_URL = 'https://github.com/msbayindir/rag-chunker/discussions'

/**
 * Errors that point at the tool rather than at the user's input or setup get a link to report
 * them: unexpected provider answers, and anything that is not a RagChunkerError at all. A missing
 * file, an unsupported input or a configuration mistake is the user's to fix.
 */
const REPORTABLE = new Set(['PROVIDER_ERROR'])

export function reportError(error: unknown, verbose = false): number {
  err()
  let reportable = false
  if (error instanceof RagChunkerError) {
    err(`  ${sym.fail}  ${pc.red(error.message)}`)
    if (error.hint) err(`     ${pc.dim(error.hint)}`)
    if (verbose && error.cause instanceof Error && error.cause.stack) err(pc.dim(error.cause.stack))
    reportable = REPORTABLE.has(error.code)
  } else if (error instanceof Error) {
    err(`  ${sym.fail}  ${pc.red(error.message)}`)
    if (verbose && error.stack) err(pc.dim(error.stack))
    else err(`     ${pc.dim('Run again with --verbose for details.')}`)
    reportable = true
  } else {
    err(`  ${sym.fail}  ${pc.red(String(error))}`)
    reportable = true
  }
  if (reportable)
    err(`     ${pc.dim(`If this looks like a bug in rag-chunker, please report it: ${ISSUES_URL}`)}`)
  err()
  return 1
}

export function parseIntOption(name: string) {
  return (value: string): number => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 0) {
      throw new RagChunkerError('CONFIG_INVALID', `--${name} must be a non-negative integer (got "${value}")`)
    }
    return n
  }
}

export function mask(secret: string | undefined): string {
  if (!secret) return pc.dim('not set')
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`
}
