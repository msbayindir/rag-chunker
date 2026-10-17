import { type Block, parseBlocks } from './markdown.js'
import { type Atomized, atomize, tailText } from './split.js'
import { getTokenizer, type Tokenizer } from './tokenizer.js'

export type ContentType = 'text' | 'table' | 'code' | 'mixed'

export interface ChunkOptions {
  maxTokens?: number
  minTokens?: number
  overlapTokens?: number
  hardBoundaryDepth?: number
  preserveTables?: boolean
  preserveCode?: boolean
  tokenizer?: 'o200k' | 'estimate'
}

/** A chunk before ids, context and embeddings are attached. */
export interface ChunkDraft {
  /** Verbatim markdown of the chunk. */
  text: string
  tokenCount: number
  contentType: ContentType
  sectionPath: string[]
  pageStart: number
  pageEnd: number
  /** True for table/code chunks kept apart from surrounding text. */
  mustPreserve: boolean
  /** Hard-boundary group (chapter/section) the chunk belongs to. */
  group: number
  /** Trailing sentences of the previous chunk (empty unless overlapTokens > 0). */
  overlap: string
}

/** A top-level section (hard-boundary group), used for hierarchical context. */
export interface Section {
  group: number
  path: string[]
  text: string
  pageStart: number
  pageEnd: number
}

export interface ChunkResult {
  chunks: ChunkDraft[]
  sections: Section[]
  pageCount: number
  warnings: string[]
}

interface Segment {
  block: Block
  at: Atomized
  from: number
  to: number
}

/** Headroom kept in every atom budget so headings carried into a chunk still fit. */
const headingReserve = (maxTokens: number) => Math.min(48, Math.floor(maxTokens * 0.15))

function renderSegment(seg: Segment): string {
  const { head, headSep, tail, atoms } = seg.at
  let out = head
  for (let i = seg.from; i < seg.to; i++) {
    const atom = atoms[i]
    if (!atom) continue
    out += (i === seg.from ? (head ? headSep : '') : atom.sep) + atom.text
  }
  if (seg.to > seg.from || head) out += tail
  return out.trimEnd()
}

function renderChunk(segments: Segment[]): string {
  return segments
    .map(renderSegment)
    .filter((s) => s.trim() !== '')
    .join('\n\n')
    .trimEnd()
}

function estimateSegment(seg: Segment): number {
  let total = seg.at.headTokens + seg.at.tailTokens
  for (let i = seg.from; i < seg.to; i++) total += (seg.at.atoms[i]?.tokens ?? 0) + 1
  return total
}

function commonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return []
  const first = paths[0] as string[]
  let n = first.length
  for (const p of paths) {
    let i = 0
    while (i < n && i < p.length && p[i] === first[i]) i++
    n = i
  }
  return first.slice(0, n)
}

function mergeType(a: ContentType, b: ContentType): ContentType {
  return a === b ? a : 'mixed'
}

function contentTypeOf(segments: Segment[]): ContentType {
  const hasTable = segments.some((s) => s.block.kind === 'table')
  const hasCode = segments.some((s) => s.block.kind === 'code')
  const hasText = segments.some(
    (s) => s.block.kind !== 'table' && s.block.kind !== 'code' && s.block.kind !== 'heading',
  )
  if (hasTable && hasCode) return 'mixed'
  if (hasTable) return hasText ? 'mixed' : 'table'
  if (hasCode) return hasText ? 'mixed' : 'code'
  return 'text'
}

/**
 * Deterministic structure-aware chunker.
 *
 * Guarantees: every word of the input appears in the output (text is sliced verbatim, never
 * dropped); no chunk exceeds `maxTokens` unless a single table row or code line cannot be split
 * further; table parts repeat the header row; code parts keep their fences; small chunks are only
 * merged within the same section and never past `maxTokens`.
 */
export function chunkMarkdownDocument(markdown: string, options: ChunkOptions = {}): ChunkResult {
  const maxTokens = options.maxTokens ?? 512
  const minTokens = Math.min(options.minTokens ?? 64, maxTokens - 1)
  const overlapTokens = options.overlapTokens ?? 0
  const hardDepth = options.hardBoundaryDepth ?? 2
  const preserveTables = options.preserveTables ?? true
  const preserveCode = options.preserveCode ?? true
  const tok: Tokenizer = getTokenizer(options.tokenizer ?? 'o200k')
  const warnings: string[] = []

  const { blocks, pageCount } = parseBlocks(markdown, hardDepth)
  const drafts: ChunkDraft[] = []

  const fits = (segments: Segment[], estimate: number): boolean => {
    if (estimate <= maxTokens * 0.85) return true
    return tok.count(renderChunk(segments)) <= maxTokens
  }

  const emit = (segments: Segment[], mustPreserve: boolean): void => {
    const text = renderChunk(segments)
    if (text.trim() === '') return
    const contentPaths = segments.filter((s) => s.block.kind !== 'heading').map((s) => s.block.path)
    const sectionPath =
      contentPaths.length > 0 ? commonPrefix(contentPaths) : ((segments.at(-1) as Segment).block.path ?? [])
    const pages = segments.map((s) => s.block.page)
    const tokenCount = tok.count(text)
    drafts.push({
      text,
      tokenCount,
      contentType: contentTypeOf(segments),
      sectionPath: [...sectionPath],
      pageStart: Math.min(...pages),
      pageEnd: Math.max(...pages),
      mustPreserve,
      group: (segments[0] as Segment).block.group,
      overlap: '',
    })
  }

  let cur: Segment[] = []
  let curEst = 0
  const recompute = () => {
    curEst = cur.reduce((sum, s) => sum + estimateSegment(s) + 1, 0)
  }
  const contentTokens = () =>
    cur.filter((s) => s.block.kind !== 'heading').reduce((sum, s) => sum + estimateSegment(s), 0)

  /** Emits the current chunk; trailing headings move on to the next chunk so they stay with their content. */
  const flush = (mustPreserve = false) => {
    const carry: Segment[] = []
    if (!mustPreserve) {
      while (cur.length > 0 && (cur.at(-1) as Segment).block.kind === 'heading')
        carry.unshift(cur.pop() as Segment)
    }
    if (cur.length > 0) emit(cur, mustPreserve)
    cur = carry
    recompute()
  }

  /** Adds the atoms of one block to the stream, opening new chunks as needed. */
  const pack = (block: Block, at: Atomized, mustPreserve: boolean) => {
    const total = at.atoms.length
    if (total === 0) {
      // A block with no atoms (e.g. a table with only a header) is a single unit.
      const seg: Segment = { block, at, from: 0, to: 0 }
      const est = estimateSegment(seg) + 1
      if (cur.length > 0 && !fits([...cur, seg], curEst + est)) flush(mustPreserve)
      cur.push(seg)
      curEst += est
      return
    }
    let i = 0
    let seg: Segment | null = null
    while (i < total) {
      const atom = at.atoms[i]!
      let candidate: Segment[]
      let est: number
      if (seg === null) {
        const fresh: Segment = { block, at, from: i, to: i + 1 }
        candidate = [...cur, fresh]
        est = curEst + estimateSegment(fresh) + 1
        if (fits(candidate, est)) {
          seg = fresh
          cur.push(seg)
          curEst = est
          i++
          continue
        }
      } else {
        const extended: Segment = { ...seg, to: i + 1 }
        candidate = [...cur.slice(0, -1), extended]
        est = curEst + atom.tokens + 1
        if (fits(candidate, est)) {
          seg.to = i + 1
          curEst = est
          i++
          continue
        }
      }
      // Does not fit: close this chunk and continue the block in a fresh one.
      if (cur.length === 0) {
        // Cannot happen with atomize budgets, but never loop forever.
        cur.push({ block, at, from: i, to: i + 1 })
        flush(mustPreserve)
        i++
        seg = null
        continue
      }
      const onlyHeadings = cur.every((s) => s.block.kind === 'heading')
      if (onlyHeadings && !mustPreserve) {
        // Carried headings too large to share a chunk: emit them on their own.
        emit(cur, false)
        cur = []
        recompute()
      } else {
        flush(mustPreserve)
      }
      seg = null
    }
  }

  for (const block of blocks) {
    const preserved = (block.kind === 'table' && preserveTables) || (block.kind === 'code' && preserveCode)
    const at = atomize(block, maxTokens, headingReserve(maxTokens), tok)
    if (at.forcedSplit) {
      warnings.push(
        `A ${block.kind} on page ${block.page} has a row/line longer than maxTokens (${maxTokens}); it was split mid-line.`,
      )
    }

    if (block.kind === 'heading' && block.depth > 0 && block.depth <= hardDepth) {
      if (cur.some((s) => s.block.kind !== 'heading')) flush()
    }

    if (preserved) {
      // Keep a short caption and the section heading(s) right before the table/code with it.
      const prefix: Segment[] = []
      const last = cur.at(-1)
      if (
        last &&
        last.block.kind === 'text' &&
        last.from === 0 &&
        last.to === last.at.atoms.length &&
        estimateSegment(last) <= Math.min(100, maxTokens / 4)
      ) {
        prefix.unshift(cur.pop() as Segment)
      }
      while (cur.length > 0 && (cur.at(-1) as Segment).block.kind === 'heading')
        prefix.unshift(cur.pop() as Segment)
      if (cur.length > 0) {
        emit(cur, false)
      }
      cur = prefix
      recompute()
      pack(block, at, true)
      if (cur.length > 0) emit(cur, true)
      cur = []
      recompute()
      continue
    }

    if (block.kind !== 'heading' && cur.length > 0) {
      // Keep a block whole when it fits in a chunk of its own and moving it leaves no orphan behind.
      const whole: Segment = { block, at, from: 0, to: at.atoms.length }
      const wholeEst = estimateSegment(whole) + 1
      if (
        !fits([...cur, whole], curEst + wholeEst) &&
        wholeEst <= maxTokens * 0.85 &&
        contentTokens() >= minTokens
      ) {
        flush()
      }
    }
    pack(block, at, false)
  }
  if (cur.length > 0) emit(cur, false)

  const merged = mergeSmallChunks(drafts, minTokens, maxTokens, tok)

  if (overlapTokens > 0) {
    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1] as ChunkDraft
      const curr = merged[i] as ChunkDraft
      if (prev.mustPreserve || curr.mustPreserve || prev.group !== curr.group) continue
      curr.overlap = tailText(prev.text, overlapTokens, tok)
    }
  }

  return { chunks: merged, sections: buildSections(blocks), pageCount, warnings }
}

function mergeSmallChunks(
  chunks: ChunkDraft[],
  minTokens: number,
  maxTokens: number,
  tok: Tokenizer,
): ChunkDraft[] {
  const items = chunks.map((c) => ({ ...c }))
  const combine = (a: ChunkDraft, b: ChunkDraft): ChunkDraft | null => {
    const text = `${a.text}\n\n${b.text}`
    const tokenCount = tok.count(text)
    if (tokenCount > maxTokens) return null
    return {
      text,
      tokenCount,
      contentType: mergeType(a.contentType, b.contentType),
      sectionPath: commonPrefix([a.sectionPath, b.sectionPath]),
      pageStart: Math.min(a.pageStart, b.pageStart),
      pageEnd: Math.max(a.pageEnd, b.pageEnd),
      mustPreserve: false,
      group: a.group,
      overlap: '',
    }
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ChunkDraft
    if (item.mustPreserve || item.tokenCount >= minTokens) continue
    const prev = items[i - 1]
    if (prev && !prev.mustPreserve && prev.group === item.group) {
      const m = combine(prev, item)
      if (m) {
        items.splice(i - 1, 2, m)
        i -= 2
        continue
      }
    }
    const next = items[i + 1]
    if (next && !next.mustPreserve && next.group === item.group) {
      const m = combine(item, next)
      if (m) {
        items.splice(i, 2, m)
        i -= 1
      }
    }
  }
  return items
}

function buildSections(blocks: Block[]): Section[] {
  const byGroup = new Map<number, Block[]>()
  for (const b of blocks) {
    const list = byGroup.get(b.group)
    if (list) list.push(b)
    else byGroup.set(b.group, [b])
  }
  const sections: Section[] = []
  for (const [group, list] of byGroup) {
    const firstHeading = list.find((b) => b.kind === 'heading')
    const pages = list.map((b) => b.page)
    sections.push({
      group,
      path: firstHeading ? [...firstHeading.path] : [],
      text: list.map((b) => b.text).join('\n\n'),
      pageStart: Math.min(...pages),
      pageEnd: Math.max(...pages),
    })
  }
  return sections
}
