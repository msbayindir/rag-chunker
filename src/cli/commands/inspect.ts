import { Command } from 'commander'
import { readFileSync } from 'fs'
import { triagePages } from '../../pdf/triage.js'
import { PDFParse } from 'pdf-parse'

export function buildInspectCommand(): Command {
  return new Command('inspect')
    .description('Inspect a PDF and show triage stats (no API calls)')
    .argument('<pdf>', 'Path to the PDF file')
    .option('--threshold <number>', 'Text density threshold for local routing', '0.7')
    .action(async (pdfPath: string, opts: { threshold: string }) => {
      let pdfBuffer: Buffer
      try {
        pdfBuffer = readFileSync(pdfPath)
      } catch {
        process.stderr.write(`Error: Cannot read file: ${pdfPath}\n`)
        globalThis.process.exit(1)
      }

      const threshold = parseFloat(opts.threshold)

      // Get total page count
      const dataCopy = new Uint8Array(pdfBuffer).slice()
      const parser = new PDFParse({ data: dataCopy.buffer, verbosity: 0 })
      const textResult = await parser.getText({ pageJoiner: '' })
      await parser.destroy()
      const totalPages = textResult.total

      process.stdout.write(`\nFile: ${pdfPath}\n`)
      process.stdout.write(`Pages: ${totalPages}\n`)

      if (totalPages === 0) {
        process.stdout.write('No pages found.\n\n')
        return
      }

      const triage = await triagePages(pdfBuffer, { threshold })

      const localCount = triage.localPages.length
      const visionCount = triage.visionPages.length
      const localPct = Math.round((localCount / totalPages) * 100)
      const visionPct = 100 - localPct
      const estimatedSaving = Math.round(localPct * 0.9) // ~90% of vision cost saved per local page

      process.stdout.write(`Text-rich pages (local): ${localCount} (${localPct}%)\n`)
      process.stdout.write(`Visual pages (vision):   ${visionCount} (${visionPct}%)\n`)
      process.stdout.write(`Estimated cost saving (hybrid): ~${estimatedSaving}%\n`)

      if (triage.pageAnalyses.length <= 30) {
        process.stdout.write('\nPage-by-page breakdown:\n')
        for (const a of triage.pageAnalyses) {
          const bar = a.parseMethod === 'local' ? '▓' : '░'
          process.stdout.write(
            `  p${String(a.pageNum).padStart(3)}: ${bar} density=${a.textDensity.toFixed(2)} (${a.extractedChars} chars) → ${a.parseMethod}\n`
          )
        }
      }

      process.stdout.write('\n')
    })
}
