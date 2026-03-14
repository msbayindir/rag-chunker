import type { NormalizedDocument, DocumentMetadata } from '../types.js'

/**
 * Builds a Markdown document string from a NormalizedDocument.
 * Includes YAML frontmatter with document metadata.
 */
export function buildMarkdown(
  doc: NormalizedDocument,
  version: string
): string {
  const meta = doc.metadata
  const lines: string[] = []

  // YAML frontmatter
  lines.push('---')
  if (meta.title) lines.push(`title: "${meta.title.replace(/"/g, '\\"')}"`)
  if (meta.author) lines.push(`author: "${meta.author.replace(/"/g, '\\"')}"`)
  lines.push(`pages: ${meta.pageCount}`)
  lines.push('source_format: pdf')
  lines.push(`source_hash: "${meta.sourceHash}"`)
  lines.push(`extracted_at: "${meta.extractedAt}"`)
  lines.push(`extraction_method: "${meta.extractionMethod}"`)
  lines.push(`rag_chunker_version: "${version}"`)
  lines.push('---')
  lines.push('')

  // Document body
  for (const section of doc.sections) {
    if (section.heading && section.headingLevel !== null) {
      lines.push(`${'#'.repeat(section.headingLevel)} ${section.heading}`)
      lines.push('')
    }

    if (section.body.trim()) {
      lines.push(section.body.trim())
      lines.push('')
    }
  }

  return lines.join('\n')
}

/** Returns the line number (1-based) for a given character offset in a string. */
export function charOffsetToLine(text: string, charOffset: number): number {
  const slice = text.slice(0, charOffset)
  return (slice.match(/\n/g) ?? []).length + 1
}
