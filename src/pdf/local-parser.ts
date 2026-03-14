import { createHash } from 'crypto'
import { PDFParse } from 'pdf-parse'
import type { NormalizedDocument, NormalizedSection, DocumentMetadata } from '../types.js'

// ─── Heading detection ────────────────────────────────────────────────────────

/** Maps a heading pattern match to { level, text }. */
interface HeadingMatch {
  level: number
  text: string
}

const HEADING_REGEXES: Array<{
  re: RegExp
  extract: (m: RegExpMatchArray) => HeadingMatch
}> = [
  // Markdown-style: # Title, ## Title, etc.
  {
    re: /^(#{1,6})\s+(.+)$/,
    extract: m => ({ level: m[1]!.length, text: m[2]!.trim() })
  },
  // Numbered sections: 1. Title, 1.1 Title, 2.3.4 Title (must start with capital or Turkish capital)
  {
    re: /^(\d+(?:\.\d+)*\.?)\s+([A-ZÇĞİÖŞÜa-zA-ZÇçĞğİıÖöŞşÜü].{2,80})$/,
    extract: m => ({
      level: (m[1]!.match(/\./g) ?? []).length + 1,
      text: m[2]!.trim()
    })
  },
  // ALL-CAPS short lines (e.g. "INTRODUCTION", "GİRİŞ") — min 4 chars, max 60
  {
    re: /^([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ\s]{3,59})$/,
    extract: m => ({ level: 1, text: m[1]!.trim() })
  }
]

function detectHeading(line: string): HeadingMatch | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 100) return null
  for (const { re, extract } of HEADING_REGEXES) {
    const m = trimmed.match(re)
    if (m) return extract(m)
  }
  return null
}

// ─── Section builder ──────────────────────────────────────────────────────────

/** Splits raw page text into NormalizedSections using heading detection. */
function splitPageIntoSections(
  pageText: string,
  pageNum: number
): NormalizedSection[] {
  const lines = pageText.split('\n')
  const sections: NormalizedSection[] = []

  let currentHeading: string | null = null
  let currentLevel: number | null = null
  let bodyLines: string[] = []

  const flush = () => {
    const body = bodyLines.join('\n').trim()
    if (body || currentHeading) {
      sections.push({
        heading: currentHeading,
        headingLevel: currentLevel,
        body,
        sourcePages: [pageNum],
        parseMethod: 'local'
      })
    }
    bodyLines = []
  }

  for (const line of lines) {
    const heading = detectHeading(line)
    if (heading) {
      flush()
      currentHeading = heading.text
      currentLevel = heading.level
    } else {
      bodyLines.push(line)
    }
  }
  flush()

  return sections
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses the specified pages of a PDF locally (no Gemini API call).
 * Returns a NormalizedDocument with sections detected from the extracted text.
 *
 * @param buffer - Full PDF buffer.
 * @param pageNums - 1-based page numbers to include.
 * @param extractionMethod - The method reported in metadata.
 */
export async function parseLocalPages(
  buffer: Buffer | Uint8Array,
  pageNums: number[],
  extractionMethod: 'local-only' | 'hybrid' = 'local-only'
): Promise<NormalizedDocument> {
  // Copy to avoid TypedArray transfer-ownership issues
  const dataCopy = new Uint8Array(buffer).slice()
  const parser = new PDFParse({ data: dataCopy.buffer, verbosity: 0 })

  // Use partial to only parse the requested pages when provided
  const textResult = await parser.getText(
    pageNums.length > 0
      ? { partial: pageNums, pageJoiner: '' }
      : { pageJoiner: '' }
  )
  await parser.destroy()

  const pageCount = textResult.total
  const pageSet = new Set(pageNums)
  const sections: NormalizedSection[] = []

  for (const page of textResult.pages) {
    if (pageNums.length > 0 && !pageSet.has(page.num)) continue
    const pageSections = splitPageIntoSections(page.text, page.num)
    sections.push(...pageSections)
  }

  const sourceHash = `sha256:${createHash('sha256').update(Buffer.from(buffer)).digest('hex')}`

  const metadata: DocumentMetadata = {
    title: null,
    author: null,
    pageCount,
    sourceHash,
    extractedAt: new Date().toISOString(),
    extractionMethod
  }

  return { sections, metadata }
}
