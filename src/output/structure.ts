import type { Section } from '../chunker/chunker.js'
import { parseBlocks } from '../chunker/markdown.js'
import type { Chunk } from '../types.js'

export interface DocumentStructure {
  pageCount: number
  headings: Array<{ level: number; text: string; page: number }>
  tables: Array<{ page: number; rows: number; columns: number; caption: string | null }>
  sections: Array<{ path: string[]; pageStart: number; pageEnd: number }>
  codeBlocks: number
  totalTokens: number
}

/** Summarises headings, tables and sections of the final markdown. */
export function buildStructure(
  markdown: string,
  chunks: Chunk[],
  sections: Section[],
  pageCount: number,
): DocumentStructure {
  const { blocks } = parseBlocks(markdown, 2)
  const headings: DocumentStructure['headings'] = []
  const tables: DocumentStructure['tables'] = []
  let codeBlocks = 0
  blocks.forEach((b, i) => {
    if (b.kind === 'heading') headings.push({ level: b.depth, text: b.title, page: b.page })
    else if (b.kind === 'code') codeBlocks++
    else if (b.kind === 'table') {
      const lines = b.text.split('\n')
      const columns = (lines[0] ?? '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
      const prev = blocks[i - 1]
      const caption =
        prev && prev.kind === 'text' && prev.text.length <= 200 ? prev.text.replace(/\s+/g, ' ').trim() : null
      tables.push({ page: b.page, rows: Math.max(0, lines.length - 2), columns, caption })
    }
  })
  return {
    pageCount,
    headings,
    tables,
    sections: sections.map((s) => ({ path: s.path, pageStart: s.pageStart, pageEnd: s.pageEnd })),
    codeBlocks,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenCount, 0),
  }
}
