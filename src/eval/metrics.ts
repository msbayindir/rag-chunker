import type { TableData } from '../documents/tables.js'

/**
 * Text and layout metrics shared by the benchmarks: edit distances on strings and sequences, a
 * reader for reference tables given as HTML, markdown → plain text, and box overlap. Nothing here
 * knows about a particular dataset.
 */

/** Levenshtein distance between two strings (code units), O(a·b) time, O(b) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length] as number
}

/** Edit distance divided by the longer length: 0 for identical strings, 1 for nothing in common. */
export function normalizedEditDistance(a: string, b: string): number {
  const n = Math.max(a.length, b.length)
  return n === 0 ? 0 : levenshtein(a, b) / n
}

/** Levenshtein distance between two sequences of comparable values. */
export function sequenceEditDistance<T>(a: readonly T[], b: readonly T[]): number {
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length] as number
}

/**
 * How far a predicted reading order is from the reference: the sequence of reference ranks in
 * predicted order against the same ranks sorted, as a normalised edit distance (0 = same order).
 */
export function readingOrderDistance(predictedOrder: readonly number[]): number {
  if (predictedOrder.length <= 1) return 0
  const sorted = [...predictedOrder].sort((a, b) => a - b)
  return sequenceEditDistance(predictedOrder, sorted) / predictedOrder.length
}

/** NFKC, lowercase, one space between tokens — what text comparison looks at. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

// ── LaTeX → text, the way OmniDocBench's scorer does it (pylatexenc's LatexNodes2Text) ─────────

const LATEX_SYMBOLS: Record<string, string> = {
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  ll: '≪',
  gg: '≫',
  times: '×',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  pm: '±',
  mp: '∓',
  div: '÷',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '•',
  oplus: '⊕',
  otimes: '⊗',
  setminus: '∖',
  infty: '∞',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  varnothing: '∅',
  sum: '∑',
  prod: '∏',
  int: '∫',
  iint: '∬',
  oint: '∮',
  partial: '∂',
  nabla: '∇',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  longrightarrow: '⟶',
  uparrow: '↑',
  downarrow: '↓',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  equiv: '≡',
  propto: '∝',
  perp: '⊥',
  parallel: '∥',
  mid: '∣',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  wedge: '∧',
  lor: '∨',
  vee: '∨',
  angle: '∠',
  triangle: '△',
  prime: "'",
  degree: '°',
  ell: 'ℓ',
  hbar: 'ħ',
  Re: 'ℜ',
  Im: 'ℑ',
  aleph: 'ℵ',
  wp: '℘',
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  vert: '|',
  Vert: '‖',
  lvert: '|',
  rvert: '|',
  lVert: '‖',
  rVert: '‖',
  colon: ':',
  dagger: '†',
  ddagger: '‡',
  S: '§',
  P: '¶',
  copyright: '©',
  checkmark: '✔',
  surd: '√',
  top: '⊤',
  bot: '⊥',
  vdash: '⊢',
  models: '⊨',
  because: '∵',
  therefore: '∴',
  ldotp: '.',
  cdotp: '·',
  bigcup: '⋃',
  bigcap: '⋂',
  coprod: '∐',
  bigoplus: '⨁',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  quad: '  ',
  qquad: '    ',
  ',': ' ',
  ';': ' ',
  ':': ' ',
  '!': '',
  ' ': ' ',
  '\\': '\n',
  '%': '%',
  '&': '&',
  _: '_',
  '#': '#',
  $: '$',
  '{': '{',
  '}': '}',
}

/** Commands whose only effect is typography: the argument stays, the command goes. */
const LATEX_WRAPPERS =
  /\\(?:mathrm|mathit|mathsf|mathtt|text|textbf|textit|textrm|textsf|texttt|textsc|emph|operatorname|mbox|textcircled|underline|overline|hat|bar|vec|tilde|dot|ddot|widehat|widetilde|overrightarrow|overleftarrow|underbrace|overbrace|boxed|displaystyle|textstyle|scriptstyle|mathop|mathrel|mathbin|mathord|mathpunct|mathinner|mathclose|mathopen|stackrel|phantom|hphantom|vphantom|cancel|label|ref|cite|eqref|tag|textup|textnormal|mathnormal)\s*\{([^{}]*)\}/g

/** Letters set in a math alphabet (pylatexenc renders \mathbf{x} as 𝐱, \mathbb{R} as ℝ, \mathcal{L} as ℒ). */
const MATH_ALPHABETS: Record<
  string,
  { upper: number; lower: number; digit?: number; except?: Record<string, string> }
> = {
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  bb: {
    upper: 0x1d538,
    lower: 0x1d552,
    digit: 0x1d7d8,
    except: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
  },
  cal: {
    upper: 0x1d49c,
    lower: 0x1d4b6,
    except: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
  },
  frak: { upper: 0x1d504, lower: 0x1d51e, except: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' } },
}

function mathAlphabet(text: string, style: string): string {
  const a = MATH_ALPHABETS[style]
  if (!a) return text
  return [...text]
    .map((ch) => {
      if (a.except?.[ch]) return a.except[ch]
      if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(a.upper + ch.charCodeAt(0) - 65)
      if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(a.lower + ch.charCodeAt(0) - 97)
      if (a.digit !== undefined && ch >= '0' && ch <= '9')
        return String.fromCodePoint(a.digit + ch.charCodeAt(0) - 48)
      return ch
    })
    .join('')
}

const MATH_FONTS: Record<string, string> = {
  mathbf: 'bold',
  boldsymbol: 'bold',
  bm: 'bold',
  pmb: 'bold',
  mathbb: 'bb',
  mathcal: 'cal',
  mathscr: 'cal',
  mathfrak: 'frak',
}

/**
 * Renders a LaTeX formula as plain text close to what pylatexenc's LatexNodes2Text produces: symbols
 * and Greek letters as Unicode, \frac{a}{b} as a/b, \sqrt{x} as √(x), font commands applied or
 * dropped, \left/\right and sizing removed, unknown commands dropped with their arguments kept,
 * braces removed, `_` and `^` kept as they are.
 */
export function latexToText(latex: string): string {
  let s = latex
  for (let i = 0; i < 8 && /\\(?:frac|dfrac|tfrac|sqrt)\b/.test(s); i++) {
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\sqrt\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, '√($1)')
      .replace(/\\[dt]?frac\s*(\S)\s*(\S)/g, '$1/$2')
  }
  for (let i = 0; i < 8; i++) {
    const before = s
    s = s.replace(
      /\\(mathbf|boldsymbol|bm|pmb|mathbb|mathcal|mathscr|mathfrak)\s*\{([^{}]*)\}/g,
      (_m, cmd: string, inner: string) => mathAlphabet(latexToText(inner), MATH_FONTS[cmd] ?? ''),
    )
    // The argument is rendered on its own, so a command inside the braces cannot swallow the
    // whitespace that follows the group.
    s = s.replace(LATEX_WRAPPERS, (_m, inner: string) => latexToText(inner))
    if (s === before) break
  }
  // A named command swallows the whitespace after it (pylatexenc does the same); an escaped
  // character does not. Names without a symbol (\left, \big, unknown commands) disappear.
  s = s.replace(
    /\\([a-zA-Z]+)\s*|\\([,;:!\\%&_#${} ])/g,
    (_m, name: string | undefined, ch: string | undefined) =>
      name !== undefined ? (LATEX_SYMBOLS[name] ?? '') : (LATEX_SYMBOLS[ch ?? ''] ?? ch ?? ''),
  )
  return s.replace(/[{}]/g, '').replace(/~/g, ' ')
}

const INLINE_FORMULA = /\$(.*?)\$|\\\((.*?)\\\)/gs
const CIRCLED: Record<string, string> = Object.fromEntries(
  [...'①②③④⑤⑥⑦⑧⑨⑩']
    .map((c, i) => [c, String(i + 1)])
    .concat(
      [...'ⒶⒷⒸⒹⒺⒻ'].map((c, i) => [c, 'ABCDEF'[i] ?? c]),
      [...'ⓐⓑⓒⓓⓔⓕ'].map((c, i) => [c, 'abcdef'[i] ?? c]),
    ),
)

/**
 * OmniDocBench's text normalisation (`normalized_text` = `clean_string(textblock2unicode(text))`):
 * inline formulas that contain a command, `^` or `_` are rendered as text; then everything except
 * letters, digits and underscores is removed, so spaces, punctuation and case-less symbols never
 * count. Case is kept. Used for both the reference and the prediction, as the official scorer does.
 */
export function officialNormalize(text: string): string {
  let s = text.replace(/[①-⑩ⒶⒷⒸⒹⒺⒻⓐⓑⓒⓓⓔⓕ]/g, (c) => CIRCLED[c] ?? c)
  s = s.replace(INLINE_FORMULA, (whole, a: string | undefined, b: string | undefined) => {
    const content = (a ?? b ?? '').replace(/\\([\\_&%^])/g, '')
    if (!/[\\^_]/.test(content)) return whole
    if (content.length > 128 || /\\(?:begin|end|array|matrix)\b/.test(content)) return whole
    return latexToText(content).trim()
  })
  return s.replace(/\\[tn]/g, '').replace(/[^\p{L}\p{N}_]/gu, '')
}

/** Markdown of a page as plain text: tables, images, fences, heading marks and emphasis removed. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ' '))
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+|^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : ' ',
    )

/** Cell text as plain words: tags, LaTeX delimiters and entities out, whitespace folded. */
export function cellText(html: string): string {
  return (
    decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
      .replace(/\$+/g, ' ')
      // \mathbf{x} → x; other commands keep their name as a word (\alpha → alpha).
      .replace(
        /\\(?:mathbf|mathrm|mathit|mathsf|mathcal|boldsymbol|bm|textbf|textit|textrm|text|emph|operatorname)\s*\{([^{}]*)\}/g,
        ' $1 ',
      )
      .replace(/\\[a-zA-Z]+/g, (m) => ` ${m.slice(1)} `)
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Reads a reference table given as HTML (`<table><tr><td colspan=2>…`) into the cell structure
 * rag-chunker uses, with the standard table layout algorithm for spans. `<th>` rows at the top
 * count as header rows. Returns null when there are no cells.
 */
export function htmlTableToData(html: string): TableData | null {
  const cells: TableData['cells'] = []
  const occupied = new Set<string>()
  let row = -1
  let headerRows = 0
  let sawBody = false
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  for (const tr of html.matchAll(rowRe)) {
    row++
    let col = 0
    let allHeader = true
    let any = false
    for (const m of (tr[1] as string).matchAll(cellRe)) {
      any = true
      const tag = (m[1] as string).toLowerCase()
      const attrs = m[2] as string
      if (tag !== 'th') allHeader = false
      const colSpan = Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1) || 1)
      const rowSpan = Math.max(1, Number(/rowspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1) || 1)
      while (occupied.has(`${row}:${col}`)) col++
      for (let r = row; r < row + rowSpan; r++)
        for (let c = col; c < col + colSpan; c++) occupied.add(`${r}:${c}`)
      cells.push({ row, col, rowSpan, colSpan, text: cellText(m[3] as string) })
      col += colSpan
    }
    if (any && allHeader && !sawBody) headerRows = row + 1
    else if (any) sawBody = true
  }
  if (cells.length === 0) return null
  const rows = cells.reduce((m, c) => Math.max(m, c.row + c.rowSpan), 0)
  const cols = cells.reduce((m, c) => Math.max(m, c.col + c.colSpan), 0)
  return { rows, cols, headerRows: Math.max(1, Math.min(headerRows, rows)), cells, source: 'ruled' }
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Intersection over union of two boxes (same units). */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Share of `a` covered by `b`. */
export function coverage(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const own = a.w * a.h
  return own > 0 ? (ix * iy) / own : 0
}
