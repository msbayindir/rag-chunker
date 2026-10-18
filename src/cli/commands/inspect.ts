import { spawn } from 'node:child_process'
import { Command } from 'commander'
import pc from 'picocolors'
import { readOutputDir } from '../../output/writer.js'
import { startInspectServer } from '../inspect/server.js'
import { err, formatMs, formatNumber, parseIntOption, reportError, sym } from '../ui.js'

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Opening the browser is a convenience; the URL is printed anyway.
  }
}

async function printSummary(dir: string): Promise<void> {
  const { manifest: m, structure, chunks } = await readOutputDir(dir)
  const s = m.stages
  err()
  err(
    `  ${pc.bold(m.source.name)}  ${pc.dim(`${m.source.kind} · rag-chunker v${m.version} · ${m.createdAt}`)}`,
  )
  err()
  err(
    `  OCR        ${s.ocr.model} ${pc.dim(`(${s.ocr.pages} pages, ${s.ocr.ocrPages} OCR'd, ${s.ocr.scannedPages} scanned)`)}`,
  )
  err(
    `  Headings   ${s.structure ? `${s.structure.model} ${pc.dim(`(${s.structure.corrections} fixes)`)}` : pc.dim('off')}`,
  )
  err(
    `  Chunks     ${s.chunk.count} ${pc.dim(`(avg ${s.chunk.avgTokens}, ${s.chunk.minTokens}–${s.chunk.maxTokens} tokens; text ${s.chunk.byType.text}, table ${s.chunk.byType.table}, code ${s.chunk.byType.code}, mixed ${s.chunk.byType.mixed})`)}`,
  )
  err(
    `  Context    ${s.context ? `${s.context.model} ${pc.dim(`(${s.context.strategy}, ${s.context.enriched} enriched, ${s.context.failed} failed)`)}` : pc.dim('off')}`,
  )
  err(
    `  Embedding  ${s.embedding ? `${s.embedding.model} ${pc.dim(`(${s.embedding.dimensions} dimensions)`)}` : pc.dim('off')}`,
  )
  if (structure) {
    err(
      `  Structure  ${structure.headings.length} headings, ${structure.tables.length} tables, ${formatNumber(structure.totalTokens)} tokens`,
    )
  }
  err(
    `  Usage      ${formatNumber(m.usage.total.requests)} requests, ${formatNumber(m.usage.total.inputTokens)} in / ${formatNumber(m.usage.total.outputTokens)} out`,
  )
  err(`  Duration   ${formatMs(m.durationMs)}`)
  if (m.warnings.length)
    err(`  ${sym.warn} ${pc.yellow(`${m.warnings.length} warning(s)`)} ${pc.dim('— see manifest.json')}`)
  if (chunks.length > 0) {
    err()
    err(pc.dim(`  First chunk (${chunks[0]?.sectionPath.join(' › ') || 'no section'}):`))
    err(pc.dim(`  ${(chunks[0]?.rawContent ?? '').slice(0, 240).replace(/\n/g, ' ')}…`))
  }
  err()
}

export function inspectCommand(): Command {
  return new Command('inspect')
    .description('Summarise an output folder, or browse it in a local web UI')
    .argument('<dir>', 'output folder written by `rag-chunker process`')
    .option('--ui', 'open the browser UI')
    .option('--pdf <file>', 'original PDF, shown next to the extracted text')
    .option('--port <port>', 'port for the UI (default: random)', parseIntOption('port'))
    .option('--no-open', 'do not open the browser automatically')
    .action(async (dir: string, flags: { ui?: boolean; pdf?: string; port?: number; open?: boolean }) => {
      try {
        if (!flags.ui) {
          await printSummary(dir)
          return
        }
        const server = await startInspectServer({ dir, pdf: flags.pdf, port: flags.port })
        err()
        err(`  ${pc.cyan('◆')}  Inspector running at ${pc.bold(server.url)}`)
        err(`     ${pc.dim('Press Ctrl+C to stop')}`)
        err()
        if (flags.open !== false) openBrowser(server.url)
        const stop = async () => {
          await server.close()
          process.exit(0)
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
}
