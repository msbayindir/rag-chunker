import type { Heading, List, Paragraph, Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type BlockKind = 'heading' | 'text' | 'list' | 'table' | 'code' | 'figure' | 'other'

/** A top-level markdown block, sliced verbatim from the source. */
export interface Block {
  index: number
  kind: BlockKind
  /** Exact source text of the block (no normalisation, no escaping). */
  text: string
  page: number
  /** Heading depth (1-6) for headings, 0 otherwise. */
  depth: number
  /** Heading text for headings, '' otherwise. */
  title: string
  /** Section breadcrumb at this block (includes the heading itself for headings). */
  path: string[]
  /** Hard-boundary group index (increments at headings with depth <= hardBoundaryDepth). */
  group: number
  /** List items (verbatim) when kind === 'list'. */
  items?: string[]
  /** True for loose lists (blank lines between items). */
  spread?: boolean
}

export interface ParsedMarkdown {
  blocks: Block[]
  /** Highest page number seen (1 when the document has no page markers). */
  pageCount: number
}

export const PAGE_MARKER_RE = /^<!--\s*page\s+(\d+)\s*-->$/i
const INLINE_PAGE_MARKER_RE = /[ \t]*<!--\s*page\s+(\d+)\s*-->[ \t]*/gi

const processor = unified().use(remarkParse).use(remarkGfm)

/** Puts every page marker on its own paragraph so the parser sees it as a standalone HTML block. */
export function normalizePageMarkers(markdown: string): string {
  return markdown.replace(INLINE_PAGE_MARKER_RE, (_m, n: string) => `\n\n<!-- page ${n} -->\n\n`)
}

export function parseMarkdownTree(markdown: string): Root {
  return processor.parse(markdown) as Root
}

/** Plain text of an mdast node (used for heading titles). */
export function nodeText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[]; alt?: unknown }
  if (typeof n.value === 'string') return n.value
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('')
  if (typeof n.alt === 'string') return n.alt
  return ''
}

function slice(
  source: string,
  node: { position?: { start: { offset?: number }; end: { offset?: number } } },
): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return ''
  return source.slice(start, end)
}

function kindOf(node: RootContent): BlockKind {
  switch (node.type) {
    case 'heading':
      return 'heading'
    case 'paragraph': {
      // A paragraph that is one image reference is a figure.
      const kids = (node as Paragraph).children.filter((c) => !(c.type === 'text' && c.value.trim() === ''))
      return kids.length === 1 && kids[0]?.type === 'image' ? 'figure' : 'text'
    }
    case 'list':
      return 'list'
    case 'table':
      return 'table'
    case 'code':
      return 'code'
    default:
      return 'other'
  }
}

/** Back-matter headings (references, bibliography) never contain the headings that follow them. */
const BACK_MATTER_RE =
  /^(?:\d+(?:\.\d+)*\.?\s+)?(?:kaynaklar|kaynakça|referanslar|references|bibliography|works cited)$/iu

/**
 * Parses markdown into top-level blocks with page numbers and section paths.
 * Page markers (`<!-- page N -->`) are consumed and never appear in block text.
 */
export function parseBlocks(markdown: string, hardBoundaryDepth: number): ParsedMarkdown {
  const source = normalizePageMarkers(markdown)
  const tree = parseMarkdownTree(source)
  const blocks: Block[] = []
  const stack: Array<{ depth: number; title: string }> = []
  let page = 1
  let pageCount = 1
  let group = 0
  let groupHasContent = false

  for (const node of tree.children) {
    if (node.type === 'html') {
      const m = PAGE_MARKER_RE.exec(node.value.trim())
      if (m) {
        page = Number.parseInt(m[1] as string, 10)
        if (page > pageCount) pageCount = page
        continue
      }
    }
    if (node.type === 'thematicBreak') continue

    const text = slice(source, node).replace(/\s+$/, '')
    if (text.trim() === '') continue

    const kind = kindOf(node)
    let depth = 0
    let title = ''
    if (kind === 'heading') {
      depth = (node as Heading).depth
      title = nodeText(node).replace(/\s+/g, ' ').trim()
      if (depth <= hardBoundaryDepth && groupHasContent) {
        group++
        groupHasContent = false
      }
      while (stack.length > 0) {
        const top = stack.at(-1) as { depth: number; title: string }
        if (top.depth < depth && !BACK_MATTER_RE.test(top.title)) break
        stack.pop()
      }
      stack.push({ depth, title })
    } else {
      groupHasContent = true
    }

    const block: Block = {
      index: blocks.length,
      kind,
      text,
      page,
      depth,
      title,
      path: stack.map((h) => h.title).filter((t) => t !== ''),
      group,
    }
    if (kind === 'list') {
      const list = node as List
      block.items = list.children
        .map((item) => slice(source, item).replace(/\s+$/, ''))
        .filter((s) => s !== '')
      block.spread = list.spread === true
    }
    blocks.push(block)
  }

  return { blocks, pageCount }
}
