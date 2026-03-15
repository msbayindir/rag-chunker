import { Command } from 'commander'
import { readFileSync } from 'fs'
import ora from 'ora'
import chalk from 'chalk'
import { runMistralOcr } from '../../ocr/mistral.js'
import { runGeminiVisionOcr } from '../../ocr/gemini-vision.js'

export function buildOcrCommand(): Command {
  return new Command('ocr')
    .description('Run OCR on a PDF and print page markdowns (debug)')
    .argument('<pdf>', 'Path to the PDF file')
    .option('-k, --gemini-api-key <key>', 'Gemini API key (fallback OCR, default: GEMINI_API_KEY env)')
    .option('-m, --mistral-api-key <key>', 'Mistral API key (primary OCR, default: MISTRAL_API_KEY env)')
    .option('--model <model>', 'Override OCR model name')
    .action(async (pdfPath: string, opts: {
      geminiApiKey?: string
      mistralApiKey?: string
      model?: string
    }) => {
      const geminiApiKey = opts.geminiApiKey ?? globalThis.process.env['GEMINI_API_KEY']
      const mistralApiKey = opts.mistralApiKey ?? globalThis.process.env['MISTRAL_API_KEY']

      if (!mistralApiKey && !geminiApiKey) {
        process.stderr.write(
          'Error: API key required (--mistral-api-key / --gemini-api-key or env vars)\n'
        )
        globalThis.process.exit(1)
      }

      let pdfBuffer: Buffer
      try {
        pdfBuffer = readFileSync(pdfPath)
      } catch {
        process.stderr.write(`Error: Cannot read file: ${pdfPath}\n`)
        globalThis.process.exit(1)
      }

      const spinner = ora({ stream: process.stderr, prefixText: ' ', color: 'cyan' })
        .start(chalk.dim(mistralApiKey ? 'Running Mistral OCR 3...' : 'Running Gemini Vision OCR...'))

      try {
        const result = mistralApiKey
          ? await runMistralOcr(pdfBuffer, { apiKey: mistralApiKey, model: opts.model })
          : await runGeminiVisionOcr(pdfBuffer, { apiKey: geminiApiKey!, model: opts.model })

        spinner.succeed(chalk.green(`OCR complete`) + chalk.dim(` — ${result.pageCount} pages · ${result.model}`))
        process.stderr.write('\n')

        for (const page of result.pages) {
          process.stdout.write(chalk.bold(`\n── Page ${page.pageNumber} ──\n\n`))
          process.stdout.write(page.markdown)
          process.stdout.write('\n')
        }
      } catch (err) {
        spinner.fail(chalk.red('OCR failed'))
        process.stderr.write(chalk.red('\n  ' + (err instanceof Error ? err.message : String(err))) + '\n\n')
        globalThis.process.exit(1)
      }
    })
}
