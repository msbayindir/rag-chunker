import { PDFParse } from 'pdf-parse'

/** Per-page triage analysis result. */
export interface PageAnalysis {
  /** 1-based page number. */
  pageNum: number
  /** Number of characters extracted from this page. */
  extractedChars: number
  /** Normalized density score 0-1. */
  textDensity: number
  /** Routing decision. */
  parseMethod: 'local' | 'vision'
}

/** Triage output: pages split into local and vision sets. */
export interface TriageResult {
  /** 1-based page numbers to parse locally (no Gemini vision). */
  localPages: number[]
  /** 1-based page numbers to send to Gemini vision. */
  visionPages: number[]
  /** Per-page analysis details. */
  pageAnalyses: PageAnalysis[]
}

/**
 * Baseline character count for a typical text-dense page.
 * Used as the denominator for textDensity normalisation.
 */
const CHARS_PER_TYPICAL_PAGE = 1500

/**
 * Analyses each page of a PDF and decides whether to parse it locally or
 * send it to Gemini vision.
 *
 * @param buffer - Full PDF buffer.
 * @param opts.threshold - textDensity threshold above which a page is routed locally. Default: 0.7
 * @param opts.forceVisionPages - 1-based page numbers always sent to vision regardless of density.
 */
export async function triagePages(
  buffer: Buffer | Uint8Array,
  opts: {
    threshold?: number
    forceVisionPages?: number[]
  } = {}
): Promise<TriageResult> {
  // Copy to avoid TypedArray transfer-ownership issues when buffer is reused
  const dataCopy = new Uint8Array(buffer).slice()

  const parser = new PDFParse({ data: dataCopy.buffer, verbosity: 0 })
  const textResult = await parser.getText({ pageJoiner: '' })
  await parser.destroy()

  const threshold = opts.threshold ?? 0.7
  const forceVision = new Set(opts.forceVisionPages ?? [])

  const localPages: number[] = []
  const visionPages: number[] = []
  const pageAnalyses: PageAnalysis[] = []

  for (const page of textResult.pages) {
    const pageNum = page.num
    const extractedChars = page.text.trim().length
    const textDensity = Math.min(1.0, extractedChars / CHARS_PER_TYPICAL_PAGE)

    const isForced = forceVision.has(pageNum)
    const isLocal = !isForced && textDensity >= threshold

    const parseMethod: 'local' | 'vision' = isLocal ? 'local' : 'vision'
    pageAnalyses.push({ pageNum, extractedChars, textDensity, parseMethod })

    if (isLocal) localPages.push(pageNum)
    else visionPages.push(pageNum)
  }

  return { localPages, visionPages, pageAnalyses }
}
