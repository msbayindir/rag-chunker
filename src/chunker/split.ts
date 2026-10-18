import type { Block } from './markdown.js'
import type { Tokenizer } from './tokenizer.js'

export interface Atom {
  text: string
  /** Separator placed before this atom when it follows another atom of the same block. */
  sep: string
  tokens: number
}

/**
 * A block broken into the smallest units the chunker may distribute over chunks.
 * When a block is (re)opened in a chunk it is rendered as `head + headSep + atoms… + tail`;
 * repeating `head` is what gives every table part its header row and every code part its fences.
 */
export interface Atomized {
  head: string
  headSep: string
  tail: string
  headTokens: number
  tailTokens: number
  atoms: Atom[]
  /** True when an atom had to be cut mid-row or mid-line to fit. */
  forcedSplit: boolean
}

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })

export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const { segment } of sentenceSegmenter.segment(text)) {
    if (segment.length > 0) out.push(segment)
  }
  return out.length > 0 ? out : [text]
}

function splitWords(text: string): string[] {
  return text.split(/(?<=\s)/).filter((p) => p.length > 0)
}

/** Longest prefix (by characters) of `text` whose token count fits `budget`. Never returns ''. */
function fittingPrefix(text: string, budget: number, tok: Tokenizer): string {
  let lo = 1
  let hi = text.length
  let best = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tok.count(text.slice(0, mid)) <= budget) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  // Do not cut a surrogate pair in half.
  const code = text.charCodeAt(best - 1)
  if (best > 1 && best < text.length && code >= 0xd800 && code <= 0xdbff) best--
  return text.slice(0, best)
}

/**
 * Splits `text` into pieces of at most `budget` tokens, preferring sentence, then word,
 * then token boundaries. Concatenating the pieces reproduces `text` exactly.
 */
export function splitToBudget(text: string, budget: number, tok: Tokenizer): string[] {
  if (tok.count(text) <= budget) return [text]
  const out: string[] = []
  const levels: Array<(t: string) => string[]> = [splitSentences, splitWords]

  const pushPieces = (piece: string, level: number): void => {
    if (tok.count(piece) <= budget) {
      out.push(piece)
      return
    }
    const splitter = levels[level]
    if (!splitter) {
      let rest = piece
      while (rest.length > 0) {
        const head = fittingPrefix(rest, budget, tok)
        out.push(head)
        rest = rest.slice(head.length)
      }
      return
    }
    const parts = splitter(piece)
    if (parts.length <= 1) {
      pushPieces(piece, level + 1)
      return
    }
    // Greedily pack consecutive parts so pieces are as large as the budget allows.
    let current = ''
    for (const part of parts) {
      if (current === '') {
        current = part
        continue
      }
      if (tok.count(current + part) <= budget) {
        current += part
      } else {
        pushPieces(current, level + 1)
        current = part
      }
    }
    if (current !== '') pushPieces(current, level + 1)
  }

  pushPieces(text, 0)
  return out
}

function atomsFrom(
  parts: string[],
  sep: string,
  budget: number,
  tok: Tokenizer,
): { atoms: Atom[]; forced: boolean } {
  const atoms: Atom[] = []
  let forced = false
  for (const part of parts) {
    const pieces = splitToBudget(part, budget, tok)
    if (pieces.length > 1) forced = true
    pieces.forEach((piece, i) => {
      atoms.push({ text: piece, sep: i === 0 ? sep : '', tokens: tok.count(piece) })
    })
  }
  return { atoms, forced }
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * Breaks a block into atoms. `maxTokens` is the chunk limit; every atom is guaranteed to fit in an
 * otherwise empty chunk together with the block's head and tail plus `reserve` tokens of headroom.
 */
export function atomize(block: Block, maxTokens: number, reserve: number, tok: Tokenizer): Atomized {
  let head = ''
  let headSep = ''
  let tail = ''
  let parts: string[]
  let sep: string

  switch (block.kind) {
    case 'table': {
      const lines = block.text.split('\n')
      head = lines.slice(0, 2).join('\n')
      headSep = '\n'
      parts = lines.slice(2).filter((l) => l.trim() !== '')
      sep = '\n'
      break
    }
    case 'code': {
      const lines = block.text.split('\n')
      const first = lines[0] ?? ''
      const fence = FENCE_RE.exec(first)
      if (fence && lines.length >= 2) {
        head = first
        headSep = '\n'
        const last = lines.at(-1) ?? ''
        const closes = lines.length > 1 && last.trim().startsWith((fence[1] as string).slice(0, 3))
        tail = closes ? `\n${last}` : `\n${(fence[1] as string).slice(0, 3)}`
        parts = lines.slice(1, closes ? -1 : undefined)
      } else {
        parts = lines
      }
      sep = '\n'
      break
    }
    case 'list': {
      parts = block.items && block.items.length > 0 ? block.items : [block.text]
      sep = block.spread ? '\n\n' : '\n'
      break
    }
    case 'text': {
      parts = splitSentences(block.text)
      sep = ''
      break
    }
    case 'heading': {
      parts = [block.text]
      sep = ''
      break
    }
    default: {
      parts = block.text.split('\n')
      sep = '\n'
    }
  }

  const headTokens = head ? tok.count(head) : 0
  const tailTokens = tail ? tok.count(tail) : 0
  const budget = Math.max(8, maxTokens - headTokens - tailTokens - reserve)
  const { atoms, forced } = atomsFrom(parts, sep, budget, tok)
  // Only tables and code lose structure when a row/line is cut; long sentences or list items do not.
  const forcedSplit = forced && (block.kind === 'table' || block.kind === 'code')
  return { head, headSep, tail, headTokens, tailTokens, atoms, forcedSplit }
}

/** The trailing sentences of `text` totalling at most `maxTokens` (word-trimmed if needed). */
export function tailText(text: string, maxTokens: number, tok: Tokenizer): string {
  if (maxTokens <= 0) return ''
  const sentences = splitSentences(text.trim())
  let out = ''
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = (sentences[i] as string) + out
    if (tok.count(candidate) > maxTokens) {
      if (out !== '') break
      const words = splitWords(sentences[i] as string)
      let partial = ''
      for (let j = words.length - 1; j >= 0; j--) {
        const next = (words[j] as string) + partial
        if (tok.count(next) > maxTokens) break
        partial = next
      }
      out = partial
      break
    }
    out = candidate
  }
  return out.trim()
}
