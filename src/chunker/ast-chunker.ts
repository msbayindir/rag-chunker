import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { createHash } from 'crypto'
import { countTokens } from './token-counter.js'
import type { SectionBlock } from './types.js'

// ─── Local AST node types (avoid mdast import at this level) ─────────────────

interface MdNode {
  type: string
  depth?: number
  children?: MdNode[]
  value?: string
  lang?: string | null
  position?: { start: { line: number; column: number } }
}

interface MdRoot {
  type: 'root'
  children: MdNode[]
}

// ─── Public output type ───────────────────────────────────────────────────────

export interface ChunkData {
  content: string
  tokenCount: number
  contentType: 'text' | 'code' | 'table' | 'mixed'
  sectionPath: string[]
  pageNumber: number
  mustPreserve: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function parseMarkdown(text: string): MdRoot {
  const processor = unified().use(remarkParse).use(remarkGfm)
  return processor.parse(text) as unknown as MdRoot
}

function serializeNodes(nodes: MdNode[]): string {
  const root: MdRoot = { type: 'root', children: nodes }
  const processor = unified()
    .use(remarkGfm)
    .use(remarkStringify, { bullet: '-' } as Parameters<typeof remarkStringify>[0])
  return (processor.stringify as unknown as (tree: MdRoot) => string)(root)
}

function chunkId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

function calcContentType(
  containsTable: boolean,
  containsCode: boolean
): 'text' | 'code' | 'table' | 'mixed' {
  if (containsTable && containsCode) return 'mixed'
  if (containsTable) return 'table'
  if (containsCode) return 'code'
  return 'text'
}

function mergeBlocksToChunkData(blocks: SectionBlock[]): ChunkData {
  const allNodes = blocks.flatMap(b => b.nodes as MdNode[])
  const content = serializeNodes(allNodes)
  const containsTable = blocks.some(b => b.containsTable)
  const containsCode = blocks.some(b => b.containsCode)
  return {
    content,
    tokenCount: countTokens(content),
    contentType: calcContentType(containsTable, containsCode),
    sectionPath: blocks[0]!.sectionPath,
    pageNumber: blocks[0]!.pageNumber,
    mustPreserve: false
  }
}

function splitAtParagraphs(
  block: SectionBlock,
  maxTokens: number,
  minTokens: number
): ChunkData[] {
  const result: ChunkData[] = []
  let currentNodes: MdNode[] = []
  let currentTokens = 0

  for (const rawNode of block.nodes) {
    const node = rawNode as MdNode
    const nodeContent = serializeNodes([node])
    const nodeTokens = countTokens(nodeContent)

    if (currentTokens + nodeTokens > maxTokens && currentNodes.length > 0) {
      if (currentTokens >= minTokens) {
        const content = serializeNodes(currentNodes)
        result.push({
          content,
          tokenCount: countTokens(content),
          contentType: 'text',
          sectionPath: block.sectionPath,
          pageNumber: block.pageNumber,
          mustPreserve: false
        })
      }
      currentNodes = [node]
      currentTokens = nodeTokens
    } else {
      currentNodes.push(node)
      currentTokens += nodeTokens
    }
  }

  if (currentNodes.length > 0 && currentTokens >= minTokens) {
    const content = serializeNodes(currentNodes)
    result.push({
      content,
      tokenCount: countTokens(content),
      contentType: 'text',
      sectionPath: block.sectionPath,
      pageNumber: block.pageNumber,
      mustPreserve: false
    })
  }

  return result
}

// ─── Orphan merge ─────────────────────────────────────────────────────────────

function mergeContentTypes(
  a: ChunkData['contentType'],
  b: ChunkData['contentType']
): ChunkData['contentType'] {
  if (a === b) return a
  return 'mixed'
}

/**
 * Post-processing pass: merges chunks below `minTokens` into their neighbors.
 * Preserves mustPreserve chunks as-is (they won't be merged into).
 */
export function mergeOrphanChunks(
  chunks: ChunkData[],
  minTokens: number
): ChunkData[] {
  if (chunks.length === 0) return chunks

  // Work on a mutable copy
  const items = chunks.map(c => ({ ...c }))

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.tokenCount >= minTokens) continue

    // Try to merge into previous non-mustPreserve chunk
    if (i > 0 && !items[i - 1]!.mustPreserve) {
      const prev = items[i - 1]!
      const merged = prev.content + '\n\n' + item.content
      prev.content = merged
      prev.tokenCount = countTokens(merged)
      prev.contentType = mergeContentTypes(prev.contentType, item.contentType)
      // Remove current item
      items.splice(i, 1)
      i--
      continue
    }

    // Try to merge into next non-mustPreserve chunk
    if (i + 1 < items.length && !items[i + 1]!.mustPreserve) {
      const next = items[i + 1]!
      const merged = item.content + '\n\n' + next.content
      next.content = merged
      next.tokenCount = countTokens(merged)
      next.contentType = mergeContentTypes(item.contentType, next.contentType)
      next.sectionPath = item.sectionPath.length > 0 ? item.sectionPath : next.sectionPath
      next.pageNumber = item.pageNumber
      // Remove current item
      items.splice(i, 1)
      i--
    }
    // If can't merge either way, keep as-is (better than losing content)
  }

  return items
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AstChunkerConfig {
  maxChunkTokens?: number
  minChunkTokens?: number
  overlapTokens?: number
  preserveTables?: boolean
  preserveCodeBlocks?: boolean
  /** Log a warning when a mustPreserve chunk exceeds this token count. Default: 2000 */
  warnLargeChunkTokens?: number
  /** Minimal logger for large-chunk warnings. Optional. */
  logger?: { warn(msg: string, meta?: unknown): void }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Deterministic AST-based markdown chunker.
 *
 * Expects `fullMarkdown` to have <!-- page N --> HTML comment markers before each page.
 * Produces ChunkData[] — call finalizeChunks() to add IDs and linking.
 */
export function chunkMarkdown(
  fullMarkdown: string,
  config: AstChunkerConfig = {}
): ChunkData[] {
  const maxChunkTokens = config.maxChunkTokens ?? 512
  const minChunkTokens = config.minChunkTokens ?? 50
  const overlapTokens = config.overlapTokens ?? 0
  const preserveTables = config.preserveTables ?? true
  const preserveCodeBlocks = config.preserveCodeBlocks ?? true

  // ── Parse ──────────────────────────────────────────────────────────────────
  const ast = parseMarkdown(fullMarkdown)

  // ── Section tree construction ──────────────────────────────────────────────
  const sections: SectionBlock[] = []
  let currentPage = 1
  const headingStack: Array<{ depth: number; text: string }> = []

  let currentSection: SectionBlock = {
    headingDepth: 0,
    sectionPath: [],
    nodes: [],
    pageNumber: currentPage,
    containsTable: false,
    containsCode: false,
    tokenCount: 0
  }

  for (const child of ast.children) {
    // Page marker detection
    if (child.type === 'html' && child.value != null) {
      const m = PAGE_MARKER_RE.exec(child.value.trim())
      if (m) {
        currentPage = parseInt(m[1]!, 10)
        continue
      }
    }

    if (child.type === 'heading') {
      // Flush current section before opening a new one
      if (currentSection.nodes.length > 0) {
        const content = serializeNodes(currentSection.nodes as MdNode[])
        currentSection.tokenCount = countTokens(content)
        sections.push(currentSection)
      }

      // Pop stack entries at same or deeper depth
      const depth = child.depth ?? 1
      while (headingStack.length > 0 && headingStack.at(-1)!.depth >= depth) {
        headingStack.pop()
      }
      headingStack.push({ depth, text: getHeadingText(child) })

      currentSection = {
        headingDepth: depth,
        sectionPath: headingStack.map(h => h.text),
        nodes: [child],
        pageNumber: currentPage,
        containsTable: false,
        containsCode: false,
        tokenCount: 0
      }
    } else {
      if (child.type === 'table') currentSection.containsTable = true
      if (child.type === 'code') currentSection.containsCode = true
      currentSection.nodes.push(child)
    }
  }

  // Final flush
  if (currentSection.nodes.length > 0) {
    const content = serializeNodes(currentSection.nodes as MdNode[])
    currentSection.tokenCount = countTokens(content)
    sections.push(currentSection)
  }

  // ── Size-fitting pass ──────────────────────────────────────────────────────
  const chunks: ChunkData[] = []
  let accumulator: SectionBlock[] = []
  let accTokens = 0

  function flushAccumulator(): void {
    if (accumulator.length === 0) return
    chunks.push(mergeBlocksToChunkData(accumulator))
    accumulator = []
    accTokens = 0
  }

  for (const section of sections) {
    // H1/H2 = hard boundary
    if (section.headingDepth > 0 && section.headingDepth <= 2 && accTokens > 0) {
      flushAccumulator()
    }

    // Table/code preservation — emit as own chunk
    if (
      (section.containsTable && preserveTables) ||
      (section.containsCode && preserveCodeBlocks)
    ) {
      flushAccumulator()
      const content = serializeNodes(section.nodes as MdNode[])
      chunks.push({
        content,
        tokenCount: countTokens(content),
        contentType: calcContentType(section.containsTable, section.containsCode),
        sectionPath: section.sectionPath,
        pageNumber: section.pageNumber,
        mustPreserve: true
      })
      continue
    }

    if (accTokens + section.tokenCount <= maxChunkTokens) {
      accumulator.push(section)
      accTokens += section.tokenCount
    } else {
      flushAccumulator()
      if (section.tokenCount <= maxChunkTokens) {
        accumulator = [section]
        accTokens = section.tokenCount
      } else {
        // Section too large — split at paragraph boundaries
        const subChunks = splitAtParagraphs(section, maxChunkTokens, minChunkTokens)
        chunks.push(...subChunks)
      }
    }
  }

  flushAccumulator()

  // ── Orphan merge post-pass ────────────────────────────────────────────────
  const merged = mergeOrphanChunks(chunks, minChunkTokens)
  chunks.length = 0
  chunks.push(...merged)

  // ── Large chunk warnings ──────────────────────────────────────────────────
  const warnAt = config.warnLargeChunkTokens ?? 2000
  if (config.logger) {
    for (const c of chunks) {
      if (c.mustPreserve && c.tokenCount > warnAt) {
        config.logger.warn(
          `Large preserved chunk: ${c.tokenCount} tokens at page ${c.pageNumber} — ` +
          `table/code block exceeds recommended size for embedding quality`
        )
      }
    }
  }

  // ── Overlap post-pass ──────────────────────────────────────────────────────
  if (overlapTokens > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!
      const words = prev.content.split(/\s+/)
      let overlapText = ''
      let overlapCount = 0
      for (let j = words.length - 1; j >= 0; j--) {
        const w = words[j]!
        overlapCount += Math.ceil(w.length / 4)
        if (overlapCount > overlapTokens) break
        overlapText = w + (overlapText ? ' ' + overlapText : '')
      }
      if (overlapText) {
        const curr = chunks[i]!
        curr.content = overlapText + '\n\n' + curr.content
        curr.tokenCount = countTokens(curr.content)
      }
    }
  }

  return chunks
}

/**
 * Assigns chunkId, index, prevChunkId, nextChunkId to each ChunkData.
 * Returns partial Chunk objects (without embedding, contextSummary, content).
 */
export function finalizeChunks(chunkDatas: ChunkData[]): Array<{
  chunkId: string
  index: number
  rawContent: string
  tokenCount: number
  contentType: 'text' | 'code' | 'table' | 'mixed'
  sectionPath: string[]
  pageNumber: number
  mustPreserve: boolean
  prevChunkId: string | null
  nextChunkId: string | null
}> {
  const ids = chunkDatas.map(d => chunkId(d.content))
  return chunkDatas.map((data, index) => ({
    chunkId: ids[index]!,
    index,
    rawContent: data.content,
    tokenCount: data.tokenCount,
    contentType: data.contentType,
    sectionPath: data.sectionPath,
    pageNumber: data.pageNumber,
    mustPreserve: data.mustPreserve,
    prevChunkId: index > 0 ? ids[index - 1]! : null,
    nextChunkId: index < ids.length - 1 ? ids[index + 1]! : null
  }))
}
