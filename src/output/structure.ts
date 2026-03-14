import type {
  NormalizedDocument, NormalizedSection,
  DocumentStructure, HeadingNode, TableEntry, FigureEntry, PageMapEntry,
  ExtendedChunkResult
} from '../types.js'

let headingCounter = 0
let tableCounter = 0
let figureCounter = 0

function nextHeadingId(): string {
  return `h-${String(++headingCounter).padStart(3, '0')}`
}

function nextTableId(): string {
  return `table-${String(++tableCounter).padStart(3, '0')}`
}

function nextFigureId(): string {
  return `fig-${String(++figureCounter).padStart(3, '0')}`
}

/** Parses a markdown table to count rows and columns. */
function parseTableDimensions(text: string): { rows: number; columns: number } {
  const tableLines = text.split('\n').filter(l => l.trim().startsWith('|'))
  const dataLines = tableLines.filter(l => !/^\|[-:\s|]+\|/.test(l.trim()))
  const columns = dataLines[0]
    ? (dataLines[0].match(/\|/g) ?? []).length - 1
    : 0
  return { rows: Math.max(0, dataLines.length), columns }
}

/** Detects figure captions in section body. */
function detectFigureCaptions(body: string): string[] {
  const captions: string[] = []
  for (const line of body.split('\n')) {
    if (/^(figure|fig\.|şekil|tablo|table)\s*\d*/i.test(line.trim()) && line.trim().length > 6) {
      captions.push(line.trim())
    }
  }
  return captions
}

/**
 * Builds the document structure map from a NormalizedDocument and chunk list.
 * Tracks heading hierarchy, tables, figures, and page-to-markdown-line mapping.
 */
export function buildStructure(
  doc: NormalizedDocument,
  markdown: string
): DocumentStructure {
  // Reset counters for each build
  headingCounter = 0
  tableCounter = 0
  figureCounter = 0

  const markdownLines = markdown.split('\n')
  const headingStack: HeadingNode[] = []
  const rootHeadings: HeadingNode[] = []
  const tables: TableEntry[] = []
  const figures: FigureEntry[] = []
  const pageMap: PageMapEntry[] = []

  // Build a page → line-range map by scanning markdown for page content
  // We track which lines correspond to each source page
  const pageLineMap = new Map<number, { start: number; end: number }>()

  let lineIdx = 0
  let currentPageStart = 1

  for (const section of doc.sections) {
    const sectionStartLine = lineIdx + 1

    // Find this section's content in the markdown
    const headingLine = section.heading
      ? markdownLines.findIndex((l, i) =>
          i >= lineIdx &&
          l.trim() === `${'#'.repeat(section.headingLevel ?? 1)} ${section.heading}`.trim()
        )
      : -1

    if (headingLine >= 0) {
      lineIdx = headingLine

      // Build heading node
      const node: HeadingNode = {
        id: nextHeadingId(),
        text: section.heading!,
        level: section.headingLevel!,
        markdownLineRange: [lineIdx + 1, lineIdx + 1],
        sourcePages: section.sourcePages,
        children: []
      }

      // Insert into tree
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= node.level) {
        headingStack.pop()
      }
      if (headingStack.length === 0) {
        rootHeadings.push(node)
      } else {
        headingStack[headingStack.length - 1]!.children.push(node)
      }
      headingStack.push(node)
    }

    // Detect tables in body
    if (section.body.includes('|')) {
      const tableMatch = section.body.match(/(\|.+\|[\s\S]*?\n(?:\|[-:\s|]+\|[\s\S]*?\n)?(?:\|.+\|[\s\S]*?\n)*)/g)
      if (tableMatch) {
        for (const tableText of tableMatch) {
          const { rows, columns } = parseTableDimensions(tableText)
          const parentId = headingStack.length > 0 ? headingStack[headingStack.length - 1]!.id : null
          tables.push({
            id: nextTableId(),
            caption: null,
            rows,
            columns,
            markdownLineRange: [sectionStartLine, sectionStartLine + tableText.split('\n').length],
            sourcePage: section.sourcePages[0] ?? 0,
            parentHeading: parentId
          })
        }
      }
    }

    // Detect figures
    const figCaptions = detectFigureCaptions(section.body)
    for (const caption of figCaptions) {
      const parentId = headingStack.length > 0 ? headingStack[headingStack.length - 1]!.id : null
      figures.push({
        id: nextFigureId(),
        caption,
        sourcePage: section.sourcePages[0] ?? 0,
        parentHeading: parentId
      })
    }

    // Update page map
    for (const pageNum of section.sourcePages) {
      const existing = pageLineMap.get(pageNum)
      if (!existing) {
        pageLineMap.set(pageNum, { start: sectionStartLine, end: sectionStartLine + 5 })
      } else {
        existing.end = Math.max(existing.end, sectionStartLine + 5)
      }
    }
  }

  // Build sorted pageMap
  for (const [pageNum, range] of Array.from(pageLineMap.entries()).sort((a, b) => a[0] - b[0])) {
    pageMap.push({
      sourcePage: pageNum,
      markdownLineRange: [range.start, range.end]
    })
  }

  return {
    version: '2.0',
    headings: rootHeadings,
    tables,
    figures,
    pageMap
  }
}
