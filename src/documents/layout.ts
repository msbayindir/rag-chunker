/**
 * Where text sits on the page. The PDF text layer yields one span per heading, paragraph or list
 * item; chunks and document blocks are located by matching their text against these spans.
 */

import type { TableData } from './tables.js'

/** A rectangle as fractions of the page size (0-1), origin top-left. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A block of page text with its position. */
export interface TextSpan {
  text: string
  box: Box
  /** Cell structure when the block is a table read from the page. */
  table?: TableData
}

/** A box on a given page. */
export interface ChunkBox extends Box {
  page: number
}

const round = (n: number) => Math.round(n * 10_000) / 10_000
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** The smallest box around all of `boxes`, or null when there are none. */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return {
    x: round(clamp01(x0)),
    y: round(clamp01(y0)),
    w: round(clamp01(x1) - clamp01(x0)),
    h: round(clamp01(y1) - clamp01(y0)),
  }
}

/** Letters and digits only: immune to markdown markers, hyphenation and whitespace changes. */
export function locateKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Characters of a chunk's start/end used to recognise a paragraph that continues into the chunk. */
const EDGE = 40

/**
 * Spans that `text` covers: spans contained in the text, the span the text lies inside (a long
 * paragraph split over several chunks) and spans that overlap the start or end of the text.
 * Spans with fewer than four significant characters (page numbers, bullets) only match whole.
 */
export function matchSpans<T extends { text: string }>(text: string, spans: readonly T[]): T[] {
  const key = locateKey(text)
  if (key === '') return []
  const head = key.slice(0, EDGE)
  const tail = key.slice(-EDGE)
  // Page numbers and axis labels are too short to match inside the key; they match as whole lines.
  let lines: Set<string> | null = null
  const hasLine = (s: string) => {
    lines ??= new Set(text.split('\n').map((l) => l.trim()))
    return lines.has(s.trim())
  }
  const out: T[] = []
  for (const span of spans) {
    const s = locateKey(span.text)
    if (s === '') continue
    if (s.length < 4) {
      if (s === key || hasLine(span.text)) out.push(span)
      continue
    }
    if (key.includes(s)) {
      out.push(span)
      continue
    }
    if (s.length >= EDGE && (s.includes(key) || s.includes(head) || s.includes(tail))) out.push(span)
  }
  return out
}

export interface LocatableChunk {
  rawContent: string
  pageStart: number
  pageEnd: number
}

/** Boxes of a chunk: every text span on its pages that its text covers. */
export function locateChunk(
  chunk: LocatableChunk,
  spansByPage: ReadonlyMap<number, readonly TextSpan[]>,
): ChunkBox[] {
  const boxes: ChunkBox[] = []
  for (let page = chunk.pageStart; page <= chunk.pageEnd; page++) {
    const spans = spansByPage.get(page)
    if (!spans || spans.length === 0) continue
    for (const span of matchSpans(chunk.rawContent, spans)) boxes.push({ page, ...span.box })
  }
  return boxes
}
