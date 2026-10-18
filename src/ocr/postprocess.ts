const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const MARKER_RE = /<!--\s*page\s+\d+\s*-->/gi

/** Removes markdown image references (OCR engines emit placeholders like ![img-0.jpeg](img-0.jpeg)). */
export function stripImages(markdown: string): string {
  return markdown
    .replace(IMAGE_RE, '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** Strips a ```markdown fence that wraps the whole answer (common with vision LLMs). */
export function unwrapMarkdownFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text)
  return m ? (m[1] as string) : text
}

/** Normalises OCR output: no stray page markers, no trailing spaces, at most one blank line. */
export function cleanPageMarkdown(markdown: string, options: { stripImages: boolean }): string {
  let out = unwrapMarkdownFence(markdown).replace(MARKER_RE, '').replace(/\r\n?/g, '\n')
  if (options.stripImages) out = stripImages(out)
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeLine(line: string): string {
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const EDGE_LINES = 2

function edgeIndexes(lines: string[]): { top: number[]; bottom: number[] } {
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() !== '')
  return {
    top: nonEmpty.slice(0, EDGE_LINES).map(({ i }) => i),
    bottom: nonEmpty.slice(-EDGE_LINES).map(({ i }) => i),
  }
}

/** Short, non-heading lines whose only varying part is a number (page-number candidates). */
function pageNumberPattern(line: string): { pattern: string; numbers: number[] } | null {
  if (/^\s*#/.test(line) || line.length > 80) return null
  const text = normalizeLine(line)
  if (text.split(' ').length > 6) return null
  const numbers = (text.match(/\d+/g) ?? []).map(Number)
  if (numbers.length === 0) return null
  return { pattern: text.replace(/\d+/g, '#'), numbers }
}

/**
 * Removes running headers/footers. A line at the top or bottom of a page is removed when the same
 * text appears there on at least half of the pages; the very first/last line is also removed when
 * it only differs by a number that advances with the page (page numbers such as "Sayfa 12").
 * Needs three or more pages with text.
 */
export function removeRepeatedHeaderFooter(pages: string[]): { pages: string[]; removed: number } {
  const withText = pages.filter((p) => p.trim() !== '').length
  if (withText < 3) return { pages, removed: 0 }
  const threshold = Math.max(3, Math.ceil(withText * 0.5))
  const split = pages.map((p) => p.split('\n'))

  const exact = new Map<string, number>()
  const numbered = new Map<string, Map<number, number>>()
  split.forEach((lines, pageIndex) => {
    const { top, bottom } = edgeIndexes(lines)
    const seen = new Set<string>()
    for (const i of [...top, ...bottom]) {
      const raw = lines[i] as string
      if (raw.length > 120) continue
      const key = normalizeLine(raw)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      exact.set(key, (exact.get(key) ?? 0) + 1)
    }
    for (const i of [top[0], bottom.at(-1)]) {
      if (i === undefined) continue
      const pn = pageNumberPattern(lines[i] as string)
      if (!pn) continue
      // Count how many pages agree on the same offset between the printed number and the page index.
      const offsets = numbered.get(pn.pattern) ?? new Map<number, number>()
      for (const n of new Set(pn.numbers.map((num) => num - pageIndex)))
        offsets.set(n, (offsets.get(n) ?? 0) + 1)
      numbered.set(pn.pattern, offsets)
    }
  })

  const repeated = new Set([...exact].filter(([, n]) => n >= threshold).map(([k]) => k))
  const pageNumberLike = new Set(
    [...numbered].filter(([, offsets]) => Math.max(...offsets.values()) >= threshold).map(([k]) => k),
  )
  if (repeated.size === 0 && pageNumberLike.size === 0) return { pages, removed: 0 }

  let removed = 0
  const out = split.map((lines) => {
    const { top, bottom } = edgeIndexes(lines)
    const drop = new Set<number>()
    for (const i of [...top, ...bottom]) {
      const raw = lines[i] as string
      if (raw.length <= 120 && repeated.has(normalizeLine(raw))) drop.add(i)
    }
    for (const i of [top[0], bottom.at(-1)]) {
      if (i === undefined) continue
      const pn = pageNumberPattern(lines[i] as string)
      if (pn && pageNumberLike.has(pn.pattern)) drop.add(i)
    }
    removed += drop.size
    return lines
      .filter((_, i) => !drop.has(i))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  })
  return { pages: out, removed }
}

/** Joins pages into one markdown document with `<!-- page N -->` markers. */
export function joinPages(pages: Array<{ pageNumber: number; markdown: string }>): string {
  return pages.map((p) => `<!-- page ${p.pageNumber} -->\n\n${p.markdown}`.trimEnd()).join('\n\n')
}

/** Splits markdown with page markers back into pages (content before the first marker is page 1). */
export function splitPages(markdown: string): Array<{ pageNumber: number; markdown: string }> {
  const matches = [...markdown.matchAll(/<!--\s*page\s+(\d+)\s*-->/gi)]
  if (matches.length === 0) return [{ pageNumber: 1, markdown: markdown.trim() }]
  const out: Array<{ pageNumber: number; markdown: string }> = []
  const push = (pageNumber: number, text: string) => {
    const prev = out.at(-1)
    if (prev && prev.pageNumber === pageNumber)
      prev.markdown = [prev.markdown, text].filter(Boolean).join('\n\n')
    else out.push({ pageNumber, markdown: text })
  }
  const lead = markdown.slice(0, matches[0]?.index ?? 0).trim()
  if (lead !== '') push(1, lead)
  matches.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? markdown.length) : markdown.length
    push(Number.parseInt(m[1] as string, 10), markdown.slice(start, end).trim())
  })
  return out
}
