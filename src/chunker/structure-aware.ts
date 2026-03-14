import type { NormalizedDocument, NormalizedSection, ExtendedChunkResult, ProcessConfig } from '../types.js'

const SOFT_MAX_TOKENS = 512
const HARD_MIN_TOKENS = 100
const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Detects if a text block contains a markdown table. */
function containsTable(text: string): boolean {
  return /^\|.+\|/m.test(text)
}

/** Detects if a text block contains a fenced code block. */
function containsCodeBlock(text: string): boolean {
  return /^```/m.test(text)
}

/** Detects if a text block looks like a figure caption. */
function isFigureCaption(text: string): boolean {
  return /^(figure|fig\.|şekil|tablo|table)\s*\d*/i.test(text.trim())
}

/** Returns 'table', 'code', 'figure_caption', or 'prose'. */
function classifyContent(text: string): ExtendedChunkResult['contentType'] {
  if (containsCodeBlock(text)) return 'code'
  if (containsTable(text)) return 'table'
  if (isFigureCaption(text)) return 'figure_caption'
  return 'prose'
}

/** Splits text at paragraph boundaries to satisfy maxTokens. */
function splitAtParagraphs(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text]

  const paragraphs = text.split(/\n{2,}/)
  const result: string[] = []
  let current = ''

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para
    if (estimateTokens(candidate) > maxTokens && current) {
      result.push(current.trim())
      current = para
    } else {
      current = candidate
    }
  }
  if (current.trim()) result.push(current.trim())
  return result.length > 0 ? result : [text]
}

/** Tracks the current heading path as sections are processed. */
interface HeadingState {
  path: Array<{ text: string; level: number }>
}

function updateHeadingState(state: HeadingState, section: NormalizedSection): void {
  if (!section.heading || section.headingLevel === null) return

  const level = section.headingLevel
  // Remove entries at same or deeper level
  state.path = state.path.filter(h => h.level < level)
  state.path.push({ text: section.heading, level })
}

function getSectionPath(state: HeadingState): string[] {
  return state.path.map(h => h.text)
}

function getHeadingHierarchy(state: HeadingState): string[] {
  return state.path.map(h => `H${h.level}: ${h.text}`)
}

/** Determines if a section boundary is a strong split point (H1 or H2). */
function isStrongBoundary(section: NormalizedSection): boolean {
  return section.heading !== null && (section.headingLevel ?? 99) <= 2
}

interface PendingChunk {
  text: string
  sourcePages: number[]
  parseMethod: 'local' | 'vision'
  sectionPath: string[]
  headingHierarchy: string[]
  contentType: ExtendedChunkResult['contentType']
}

/**
 * Structure-aware chunker that respects document structure, heading boundaries,
 * and content integrity (tables, code blocks are never split).
 */
export function chunkDocument(
  doc: NormalizedDocument,
  config: Pick<ProcessConfig, 'maxChunkTokens' | 'preserveTables' | 'preserveCodeBlocks'>
): Omit<ExtendedChunkResult, 'chunkIndex' | 'chunkId' | 'contextSummary' | 'status' | 'prevChunkId' | 'nextChunkId'>[] {
  const maxTokens = config.maxChunkTokens ?? SOFT_MAX_TOKENS
  const preserveTables = config.preserveTables !== false
  const preserveCode = config.preserveCodeBlocks !== false

  const headingState: HeadingState = { path: [] }
  const pending: PendingChunk[] = []
  let currentText = ''
  let currentPages: number[] = []
  let currentParseMethod: 'local' | 'vision' = 'local'
  let currentSectionPath: string[] = []
  let currentHeadingHierarchy: string[] = []

  const flushCurrent = () => {
    if (!currentText.trim()) return
    pending.push({
      text: currentText.trim(),
      sourcePages: [...currentPages],
      parseMethod: currentParseMethod,
      sectionPath: [...currentSectionPath],
      headingHierarchy: [...currentHeadingHierarchy],
      contentType: classifyContent(currentText)
    })
    currentText = ''
    currentPages = []
  }

  for (const section of doc.sections) {
    updateHeadingState(headingState, section)

    const sectionPath = getSectionPath(headingState)
    const headingHierarchy = getHeadingHierarchy(headingState)

    // Build section text (heading + body)
    const sectionText = section.heading
      ? `${section.heading}\n\n${section.body}`.trim()
      : section.body.trim()

    if (!sectionText) continue

    const sectionTokens = estimateTokens(sectionText)
    const isTable = containsTable(sectionText)
    const isCode = containsCodeBlock(sectionText)
    const mustPreserve = (isTable && preserveTables) || (isCode && preserveCode)

    // Strong boundary (H1/H2) always flushes current accumulation
    if (isStrongBoundary(section) && currentText) {
      flushCurrent()
      currentSectionPath = sectionPath
      currentHeadingHierarchy = headingHierarchy
    }

    if (mustPreserve) {
      // Preserved blocks: flush current, emit as own chunk (even if oversized)
      flushCurrent()
      pending.push({
        text: sectionText,
        sourcePages: section.sourcePages,
        parseMethod: section.parseMethod,
        sectionPath,
        headingHierarchy,
        contentType: isCode ? 'code' : 'table'
      })
      currentSectionPath = sectionPath
      currentHeadingHierarchy = headingHierarchy
      continue
    }

    // Can this section be appended to current accumulation?
    const candidateText = currentText ? `${currentText}\n\n${sectionText}` : sectionText

    if (estimateTokens(candidateText) <= maxTokens) {
      // Fits — accumulate
      currentText = candidateText
      currentPages = [...new Set([...currentPages, ...section.sourcePages])]
      currentParseMethod = section.parseMethod
      if (!currentSectionPath.length) {
        currentSectionPath = sectionPath
        currentHeadingHierarchy = headingHierarchy
      }
    } else {
      // Doesn't fit — flush current, then process section
      flushCurrent()
      currentSectionPath = sectionPath
      currentHeadingHierarchy = headingHierarchy

      if (sectionTokens <= maxTokens) {
        // Section fits in a fresh chunk — start accumulating
        currentText = sectionText
        currentPages = [...section.sourcePages]
        currentParseMethod = section.parseMethod
      } else {
        // Section itself is oversized — split at paragraph boundaries
        const parts = splitAtParagraphs(sectionText, maxTokens)
        for (const part of parts) {
          if (estimateTokens(part) >= HARD_MIN_TOKENS) {
            pending.push({
              text: part,
              sourcePages: section.sourcePages,
              parseMethod: section.parseMethod,
              sectionPath,
              headingHierarchy,
              contentType: classifyContent(part)
            })
          } else {
            // Below hard min — merge into next accumulation
            currentText = currentText ? `${currentText}\n\n${part}` : part
            currentPages = [...new Set([...currentPages, ...section.sourcePages])]
            currentParseMethod = section.parseMethod
          }
        }
      }
    }
  }

  flushCurrent()

  // Map pending chunks to the return shape
  return pending.map(p => ({
    pageRange: {
      start: Math.min(...p.sourcePages),
      end: Math.max(...p.sourcePages)
    },
    text: p.text,
    contentHint: p.contentType === 'table' ? 'table'
      : p.contentType === 'code' ? 'mixed'
      : 'narrative',
    sectionPath: p.sectionPath,
    headingHierarchy: p.headingHierarchy,
    contentType: p.contentType,
    parseMethod: p.parseMethod,
    tokenCount: estimateTokens(p.text),
    charCount: p.text.length,
    embedding: undefined
  }))
}
