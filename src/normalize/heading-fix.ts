import { GoogleGenAI } from '@google/genai'
import { callWithRetry, extractJson } from '../utils/llm-caller.js'
import type { ILogger } from '../logger.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StructureDiscovery {
  documentType: string
  mainSections: Array<{ title: string; approximatePage: number; suggestedLevel: number }>
  recurringBlocks: Array<{ titlePattern: string; suggestedRelativeLevel: string; description: string }>
  nonHeadingPatterns: Array<{ pattern: string; suggestedAction: string; description: string }>
  structureNotes?: string
}

export interface HeadingCorrection {
  line: number
  original: string
  fixed: string
}

export interface HeadingFixResult {
  markdown: string
  corrections: HeadingCorrection[]
  structure: StructureDiscovery | null
  skipped: boolean
  phase1DurationMs: number
  phase2DurationMs: number
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PHASE1_PROMPT = `This is the full markdown text of a document digitized by an OCR tool.
Because OCR processes each page independently, heading levels (# ## ### ####) may be inconsistent.

YOUR TASK: Analyze the document structure only. Do not make any corrections yet.

Determine the following:

1. DOCUMENT TYPE: Textbook, research paper, technical report, manual, legal document, presentation notes, etc.

2. MAIN SECTIONS: The top-level divisions that form the backbone of the document.
   - If a table of contents exists, USE IT as the authoritative reference.
   - If no TOC exists, infer the main sections from the document flow.
   - Typically 3-10 main sections. If you find more than 15, you are likely at the wrong level — go up one level.

3. RECURRING BLOCKS: Structural elements that repeat at the end of sections throughout the document.
   Examples: "Summary", "Questions", "References", "Key Points", "Notes", "Clinical Correlation", "Sidebar"
   These are NEVER top-level sections — they always belong under the section they appear in.

4. NON-HEADING PATTERNS: Lines that appear as headings but should not be.
   Examples: Figure captions ("Figure 2-17..."), table captions ("Table 3-1..."), short labels ending with a colon.
   These should be demoted to H4 or lower, or treated as plain text.

5. Any special structural notes about this document.

Return ONLY valid JSON, nothing else — no explanation, no markdown fences:
{
  "documentType": "string",
  "mainSections": [
    { "title": "exact title as it appears in the document", "approximatePage": 0, "suggestedLevel": 1 }
  ],
  "recurringBlocks": [
    { "titlePattern": "exact title or pattern", "suggestedRelativeLevel": "parent+1", "description": "what this block is" }
  ],
  "nonHeadingPatterns": [
    { "pattern": "pattern description", "suggestedAction": "demote_to_h4 | demote_to_h3 | remove_heading", "description": "why it's not a heading" }
  ],
  "structureNotes": "optional notes about special structure"
}`

function buildPhase2Prompt(structure: StructureDiscovery, headingList: string): string {
  return `In phase 1, the structure of this document was analyzed:

<structure>
${JSON.stringify(structure, null, 2)}
</structure>

Below is the complete list of all headings in the document:

<headings>
${headingList}
</headings>

YOUR TASK: Determine the correct heading level for each heading. Apply these rules:

1. ONLY headings listed in mainSections can be H1 (#). No other heading should be H1.

2. Headings that are topics/sections within a main section → H2 (##).
   Numbered headings (1. Topic, 6. Topic, 19. Topic etc.) are typically H2.

3. Sub-topics within an H2 → H3 (###).

4. recurringBlocks (Questions, Summary, Key Points, Sidebars etc.) → one level below the section they appear in.
   - A recurring block after an H1 section → H2
   - A recurring block after an H2 topic → H3
   - CRITICAL: recurringBlocks must NEVER be H1.

5. nonHeadingPatterns → demote to the suggested level. Figure and table captions → H4 or lower.

6. For each heading, find its correct parent by looking at the preceding headings in context.

7. CHECK THE ENTIRE DOCUMENT from start to finish. Do not fix only the first pages and skip the rest.

Return ONLY the headings that need to change as a JSON array. Do not include correct headings.
If all headings are correct, return: []

Return ONLY valid JSON, nothing else — no explanation, no markdown fences:
[
  {"line": 403, "original": "# HEADING TEXT", "fixed": "## HEADING TEXT"},
  {"line": 1448, "original": "# QUESTIONS", "fixed": "## QUESTIONS"}
]`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractHeadingList(markdown: string): string {
  const lines = markdown.split('\n')
  let currentPage = 0
  const headings: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const pageMatch = lines[i]!.match(/<!--\s*page\s+(\d+)\s*-->/i)
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1]!, 10)
      continue
    }
    const headingMatch = lines[i]!.match(/^(#{1,6}) (.+)$/)
    if (headingMatch) {
      headings.push(`Line ${i + 1} | Page ${currentPage} | ${headingMatch[1]} ${headingMatch[2]}`)
    }
  }

  return headings.join('\n')
}

function stripInlineFormatting(text: string): string {
  return text.replace(/\*+/g, '').replace(/_+/g, '').trim()
}

function applyCorrections(
  markdown: string,
  corrections: HeadingCorrection[],
  logger: ILogger
): { result: string; applied: number; missed: string[] } {
  const lines = markdown.split('\n')
  let applied = 0
  const missed: string[] = []

  for (const c of corrections) {
    // Parse original and fixed # levels
    const origMatch = c.original.match(/^(#{1,6}) /)
    const fixedMatch = c.fixed.match(/^(#{1,6}) /)
    if (!origMatch || !fixedMatch) continue
    if (origMatch[1] === fixedMatch[1]) continue

    const newHashes = fixedMatch[1]!
    const targetText = stripInlineFormatting(c.original.slice(origMatch[1]!.length + 1))

    let found = false

    // Try line number first
    const lineIdx = c.line - 1
    if (lineIdx >= 0 && lineIdx < lines.length) {
      const line = lines[lineIdx]!
      if (stripInlineFormatting(line) === stripInlineFormatting(c.original)) {
        lines[lineIdx] = newHashes + ' ' + line.slice(origMatch[1]!.length + 1)
        found = true
        applied++
      }
    }

    // Fallback: scan all lines for matching heading text
    if (!found) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!line.match(/^#{1,6} /)) continue
        const lineText = stripInlineFormatting(line.slice((line.match(/^(#{1,6}) /)![1]!.length) + 1))
        if (lineText === targetText) {
          lines[i] = newHashes + ' ' + line.slice((line.match(/^(#{1,6}) /)![1]!.length) + 1)
          found = true
          applied++
          break
        }
      }
    }

    if (!found) {
      missed.push(c.original)
    }
  }

  return { result: lines.join('\n'), applied, missed }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * 2-phase heading hierarchy fix for OCR-produced markdown.
 *
 * Phase 1: Send full document to Gemini → get structure map (mainSections, recurringBlocks, etc.)
 * Phase 2: Send structure map + heading list → get line-by-line corrections
 *
 * Always fails gracefully — returns original markdown if either phase fails.
 */
export async function fixHeadingHierarchy(
  documentMd: string,
  config: {
    geminiApiKey: string
    /** Model for phase 1 (structure discovery — full document). Default: gemini-2.5-pro */
    phase1Model?: string
    /** Model for phase 2 (heading corrections — heading list only). Default: gemini-2.5-pro */
    phase2Model?: string
    logger: ILogger
  }
): Promise<HeadingFixResult> {
  const phase1Model = config.phase1Model ?? 'gemini-2.5-pro'
  const phase2Model = config.phase2Model ?? 'gemini-2.5-pro'
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })

  // ── Phase 1: Structure Discovery ──────────────────────────────────────────
  config.logger.info('Heading normalization phase 1: structure discovery')
  const phase1Start = Date.now()

  let structure: StructureDiscovery
  try {
    const response = await callWithRetry(() =>
      ai.models.generateContent({
        model: phase1Model,
        contents: [{ role: 'user', parts: [{ text: documentMd }, { text: PHASE1_PROMPT }] }]
      })
    )
    const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const parsed = JSON.parse(extractJson(rawText))

    if (!parsed.mainSections || !Array.isArray(parsed.mainSections)) {
      throw new Error('Phase 1 response missing mainSections array')
    }
    structure = parsed as StructureDiscovery
    config.logger.info(
      `Heading normalization phase 1 done: ${structure.documentType}, ${structure.mainSections.length} main sections`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    config.logger.warn(`Heading normalization phase 1 failed: ${msg}`)
    return {
      markdown: documentMd,
      corrections: [],
      structure: null,
      skipped: true,
      phase1DurationMs: Date.now() - phase1Start,
      phase2DurationMs: 0
    }
  }

  const phase1DurationMs = Date.now() - phase1Start

  // ── Phase 2: Heading Correction ───────────────────────────────────────────
  config.logger.info('Heading normalization phase 2: applying corrections')
  const phase2Start = Date.now()

  const headingList = extractHeadingList(documentMd)
  let corrections: HeadingCorrection[]

  try {
    const response = await callWithRetry(() =>
      ai.models.generateContent({
        model: phase2Model,
        contents: [{ role: 'user', parts: [{ text: buildPhase2Prompt(structure, headingList) }] }]
      })
    )
    const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const trimmed = extractJson(rawText).trim()

    if (!trimmed || trimmed === '[]') {
      config.logger.info('Heading normalization phase 2: no corrections needed')
      return {
        markdown: documentMd,
        corrections: [],
        structure,
        skipped: false,
        phase1DurationMs,
        phase2DurationMs: Date.now() - phase2Start
      }
    }

    corrections = JSON.parse(trimmed) as HeadingCorrection[]
    if (!Array.isArray(corrections)) throw new Error('Phase 2 response is not an array')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    config.logger.warn(`Heading normalization phase 2 failed: ${msg}`)
    return {
      markdown: documentMd,
      corrections: [],
      structure,
      skipped: true,
      phase1DurationMs,
      phase2DurationMs: Date.now() - phase2Start
    }
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const { result, applied, missed } = applyCorrections(documentMd, corrections, config.logger)
  config.logger.info(`Heading normalization phase 2: ${applied}/${corrections.length} corrections applied`)
  if (missed.length > 0) {
    config.logger.warn(
      `Heading normalization: ${missed.length} headings not found — sample: ${missed.slice(0, 3).join(' | ')}`
    )
  }

  return {
    markdown: result,
    corrections,
    structure,
    skipped: false,
    phase1DurationMs,
    phase2DurationMs: Date.now() - phase2Start
  }
}
