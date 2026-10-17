const WORD_RE = /[\p{L}\p{N}]+/gu
const MARKER_RE = /<!--\s*page\s+\d+\s*-->/gi

export function words(text: string): string[] {
  return text.replace(MARKER_RE, ' ').match(WORD_RE) ?? []
}

export function counts(list: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of list) m.set(w, (m.get(w) ?? 0) + 1)
  return m
}

/** Words of `input` (with multiplicity) that are missing from `output`. */
export function missingWords(input: string, output: string): string[] {
  const have = counts(words(output))
  const missing: string[] = []
  for (const w of words(input)) {
    const n = have.get(w) ?? 0
    if (n === 0) missing.push(w)
    else have.set(w, n - 1)
  }
  return missing
}
