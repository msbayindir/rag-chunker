import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { OcrResult } from '../ocr/types.js'
import type { Chunk } from '../types.js'
import type { DocumentStructure, DocumentHeading, TableRecord, ProcessManifest, ChunkStats } from './types.js'

export type { DocumentStructure, ProcessManifest, TableRecord } from './types.js'

// ─── Local node types ─────────────────────────────────────────────────────────

interface MdNode {
  type: string
  depth?: number
  children?: MdNode[]
  value?: string
  position?: { start: { line: number } }
}

interface MdRoot {
  type: 'root'
  children: MdNode[]
}

const PAGE_MARKER_RE = /^<!--\s*page\s+(\d+)\s*-->\s*$/i

function getHeadingText(node: MdNode): string {
  return (node.children ?? [])
    .map(c => {
      if (c.type === 'text' || c.type === 'inlineCode') return c.value ?? ''
      if (c.children) return getHeadingText(c)
      return ''
    })
    .join('')
}

// ─── buildDocumentMarkdown ────────────────────────────────────────────────────

/** Concatenates OCR pages into a single markdown string with page markers. */
export function buildDocumentMarkdown(ocrResult: OcrResult): string {
  return ocrResult.pages
    .map(p => `<!-- page ${p.pageNumber} -->\n\n${p.markdown}`)
    .join('\n\n')
}

// ─── buildStructure ───────────────────────────────────────────────────────────

// ─── Helpers for table caption detection ─────────────────────────────────────

function getNodePlainText(node: MdNode): string {
  if (node.value != null) return node.value
  return (node.children ?? []).map(c => getNodePlainText(c)).join('')
}

/** Parses the full document markdown and extracts structural metadata. */
export function buildStructure(fullMarkdown: string, chunks: Chunk[]): DocumentStructure {
  const processor = unified().use(remarkParse).use(remarkGfm)
  const ast = processor.parse(fullMarkdown) as unknown as MdRoot

  const headings: DocumentHeading[] = []
  const tables: TableRecord[] = []
  let codeBlockCount = 0
  let currentPage = 1
  let maxPage = 1

  for (let i = 0; i < ast.children.length; i++) {
    const node = ast.children[i]!

    if (node.type === 'html' && node.value != null) {
      const m = PAGE_MARKER_RE.exec(node.value.trim())
      if (m) {
        currentPage = parseInt(m[1]!, 10)
        if (currentPage > maxPage) maxPage = currentPage
        continue
      }
    }

    if (node.type === 'heading') {
      headings.push({
        level: node.depth ?? 1,
        text: getHeadingText(node),
        pageNumber: currentPage,
        markdownLine: node.position?.start.line ?? 0
      })
    } else if (node.type === 'table') {
      // Detect caption: look at the immediately preceding sibling
      let caption: string | null = null
      if (i > 0) {
        const prev = ast.children[i - 1]!
        if (prev.type === 'paragraph' || prev.type === 'heading') {
          const text = getNodePlainText(prev).trim()
          if (text) caption = text.slice(0, 200)
        }
      }

      const rows = (node.children as MdNode[])
      const rowCount = rows.length
      const columnCount = (rows[0]?.children as MdNode[] | undefined)?.length ?? 0

      tables.push({
        index: tables.length,
        caption,
        pageNumber: currentPage,
        rowCount,
        columnCount
      })
    } else if (node.type === 'code') {
      codeBlockCount++
    }
  }

  const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0)

  return {
    headings,
    tables,
    tableCount: tables.length,
    codeBlockCount,
    pageCount: maxPage,
    totalTokens
  }
}

// ─── buildManifest ────────────────────────────────────────────────────────────

function buildChunkStats(chunks: Chunk[]): ChunkStats {
  if (chunks.length === 0) {
    return {
      total: 0,
      avgTokens: 0,
      minTokens: 0,
      maxTokens: 0,
      tableChunks: 0,
      codeChunks: 0,
      textChunks: 0,
      mixedChunks: 0
    }
  }

  const tokens = chunks.map(c => c.tokenCount)
  const total = chunks.length
  return {
    total,
    avgTokens: Math.round(tokens.reduce((a, b) => a + b, 0) / total),
    minTokens: Math.min(...tokens),
    maxTokens: Math.max(...tokens),
    tableChunks: chunks.filter(c => c.contentType === 'table').length,
    codeChunks: chunks.filter(c => c.contentType === 'code').length,
    textChunks: chunks.filter(c => c.contentType === 'text').length,
    mixedChunks: chunks.filter(c => c.contentType === 'mixed').length
  }
}

export function buildManifest(opts: {
  pdfHash: string
  ocrModel: string
  contextModel: string
  contextMode: string
  chunks: Chunk[]
  startedAt: number
  ocrCacheHit: boolean
  headingFix?: ProcessManifest['headingFix']
}): ProcessManifest {
  return {
    version: '3.0',
    processedAt: new Date().toISOString(),
    pdfHash: opts.pdfHash,
    ocrModel: opts.ocrModel,
    contextModel: opts.contextModel,
    contextMode: opts.contextMode,
    chunkStats: buildChunkStats(opts.chunks),
    durationMs: Date.now() - opts.startedAt,
    ocrCacheHit: opts.ocrCacheHit,
    headingFix: opts.headingFix ?? null
  }
}

// ─── save ─────────────────────────────────────────────────────────────────────

/** Writes document.md, structure.json, chunks.jsonl, manifest.json to outputDir. */
export async function saveOutputs(
  outputDir: string,
  fullMarkdown: string,
  structure: DocumentStructure,
  chunks: Chunk[],
  manifest: ProcessManifest
): Promise<void> {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'document.md'), fullMarkdown, 'utf-8')
  writeFileSync(join(outputDir, 'structure.json'), JSON.stringify(structure, null, 2), 'utf-8')
  writeFileSync(
    join(outputDir, 'chunks.jsonl'),
    chunks.map(c => JSON.stringify(c)).join('\n'),
    'utf-8'
  )
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}
