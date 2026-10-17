import { z } from 'zod'
import type { CacheStore } from '../cache/store.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import { RagChunkerError } from '../errors.js'
import type { Reporter } from '../pipeline/events.js'
import { generateJson } from '../providers/structured.js'
import { addUsage, emptyUsage, type LLM, type Usage } from '../providers/types.js'
import { batches } from '../util/async.js'
import { sha256 } from '../util/hash.js'

const PROMPT_VERSION = 'v1'
const WINDOW = 120

export interface HeadingLine {
  /** 0-based line index in the markdown. */
  line: number
  level: number
  text: string
  page: number
}

export interface HeadingFixResult {
  markdown: string
  corrections: number
  headings: number
  documentType: string | null
  skipped: string | null
  cached: boolean
  usage: Usage
}

const structureSchema = z.strictObject({
  documentType: z.string(),
  mainSections: z.array(z.string()),
  recurringBlocks: z.array(z.string()),
  notHeadings: z.array(z.string()),
  notes: z.string(),
})
type Structure = z.infer<typeof structureSchema>

const correctionsSchema = z.strictObject({
  corrections: z.array(
    z.strictObject({
      id: z.number().int(),
      level: z.number().int().min(0).max(6),
    }),
  ),
})

/** Finds ATX headings outside fenced code blocks, with the page each one is on. */
export function findHeadings(markdown: string): HeadingLine[] {
  const lines = markdown.split('\n')
  const out: HeadingLine[] = []
  let fence: string | null = null
  let page = 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      const marker = (f[1] as string).slice(0, 3)
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const p = /^<!--\s*page\s+(\d+)\s*-->\s*$/i.exec(line.trim())
    if (p) {
      page = Number.parseInt(p[1] as string, 10)
      continue
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
    if (h) out.push({ line: i, level: (h[1] as string).length, text: (h[2] as string).trim(), page })
  }
  return out
}

const NUMBERING_RE = /^((?:\d+\.)*\d+)[.)]?\s+\S/

/**
 * Deterministic pass: headings with the same numbering depth ("2.", "3." / "2.1", "3.4") get the
 * level most of them already have, and deeper numbering is never shallower than its parent depth.
 * Fixes the typical mix of levels when pages come from different OCR engines.
 */
export function harmonizeNumberedHeadings(
  headings: HeadingLine[],
  changes: Map<number, number>,
): Map<number, number> {
  const out = new Map(changes)
  const level = (h: HeadingLine) => out.get(h.line) ?? h.level
  const byDepth = new Map<number, HeadingLine[]>()
  for (const h of headings) {
    if (level(h) === 0) continue
    const m = NUMBERING_RE.exec(h.text)
    if (!m) continue
    const depth = (m[1] as string).split('.').length
    const list = byDepth.get(depth) ?? []
    list.push(h)
    byDepth.set(depth, list)
  }
  let previous = 0
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const group = byDepth.get(depth) as HeadingLine[]
    const votes = new Map<number, number>()
    for (const h of group) votes.set(level(h), (votes.get(level(h)) ?? 0) + 1)
    let target = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1
    if (target <= previous) target = Math.min(6, previous + 1)
    if (group.length >= 2) {
      for (const h of group) if (level(h) !== target) out.set(h.line, target)
    }
    previous = group.length >= 2 ? target : Math.max(previous, level(group[0] as HeadingLine))
  }
  for (const [line, lvl] of out) {
    const h = headings.find((x) => x.line === line)
    if (h && h.level === lvl) out.delete(line)
  }
  return out
}

/** Applies level changes; level 0 turns a heading back into a paragraph. */
export function applyHeadingLevels(
  markdown: string,
  changes: Map<number, number>,
  headings: HeadingLine[],
): string {
  const lines = markdown.split('\n')
  for (const h of headings) {
    const level = changes.get(h.line)
    if (level === undefined || level === h.level) continue
    lines[h.line] = level === 0 ? h.text : `${'#'.repeat(level)} ${h.text}`
  }
  return lines.join('\n')
}

const PHASE1_SYSTEM = `You analyse the structure of documents digitised by OCR. Because OCR reads each page on its own, heading levels are often inconsistent.
Return JSON describing the document:
- documentType: textbook, paper, report, manual, legal text, slides, etc.
- mainSections: exact titles of the top-level divisions (use the table of contents when present; usually 3-15).
- recurringBlocks: titles that repeat inside many sections (e.g. "Summary", "Questions", "Key points"); they are never top level.
- notHeadings: patterns that look like headings but are not (figure/table captions, running headers, labels).
- notes: anything else that matters for heading levels.`

const PHASE2_SYSTEM = `You fix heading levels of an OCR'd document. You get the document structure and a numbered list of headings (id | page | current level | text).
Rules:
- Only main sections are level 1. Topics inside a main section are level 2, their subtopics level 3, and so on.
- Recurring blocks are one level below the section they appear in, never level 1.
- Figure/table captions, running headers and labels are not headings: use level 0.
- Numbering (1, 1.1, 1.1.1) is strong evidence for depth.
Return only headings whose level must change, as {"corrections":[{"id":..,"level":..}]}. Return an empty list when everything is correct.`

export interface HeadingFixOptions {
  llm: LLM
  cache: CacheStore
  reporter: Reporter
  signal?: AbortSignal
}

/** Two-phase, provider-agnostic heading level repair. Never throws for model output problems. */
export async function fixHeadings(markdown: string, opts: HeadingFixOptions): Promise<HeadingFixResult> {
  const usage = emptyUsage()
  const headings = findHeadings(markdown)
  const base = { headings: headings.length, usage, cached: false }
  if (headings.length < 3) {
    return { ...base, markdown, corrections: 0, documentType: null, skipped: 'fewer than 3 headings' }
  }

  const key = opts.cache.key('structure', PROMPT_VERSION, sha256(markdown), opts.llm.ref)
  const cached = await opts.cache.get<{ changes: Array<[number, number]>; documentType: string }>(
    'structure',
    key,
  )
  if (cached) {
    const changes = harmonizeNumberedHeadings(headings, new Map(cached.changes))
    return {
      ...base,
      cached: true,
      markdown: applyHeadingLevels(markdown, changes, headings),
      corrections: changes.size,
      documentType: cached.documentType,
      skipped: null,
    }
  }

  const tok = getTokenizer('o200k')
  const caps = await opts.llm.capabilities()
  const budget = Math.max(4000, Math.floor(caps.contextWindow * 0.6))
  const outline = headings.map((h, i) => `${i} | p${h.page} | ${'#'.repeat(h.level)} ${h.text}`)

  let structure: Structure
  try {
    const outlineText = tok.truncate(outline.join('\n'), Math.floor(budget * 0.5))
    const opening = tok.truncate(markdown, Math.max(1000, budget - tok.count(outlineText) - 1500))
    const res = await generateJson(
      opts.llm,
      {
        system: PHASE1_SYSTEM,
        parts: [
          { type: 'text', text: `<headings>\n${outlineText}\n</headings>` },
          { type: 'text', text: `<document_start>\n${opening}\n</document_start>` },
        ],
        maxOutputTokens: 4096,
        effort: 'medium',
        signal: opts.signal,
      },
      structureSchema,
      'document_structure',
    )
    structure = res.value
    addUsage(usage, res.usage)
  } catch (err) {
    if (isFatal(err)) throw err
    opts.reporter.warn('structure', `Heading normalization skipped: ${(err as Error).message}`)
    return { ...base, markdown, corrections: 0, documentType: null, skipped: 'structure discovery failed' }
  }

  const changes = new Map<number, number>()
  const windows = batches(
    headings.map((h, i) => ({ h, i })),
    WINDOW,
  )
  let w = 0
  for (const win of windows) {
    opts.reporter.progress('structure', w, windows.length)
    const start = win[0]?.i ?? 0
    const contextLines = outline.slice(Math.max(0, start - 15), start).map((l) => `(context) ${l}`)
    try {
      const res = await generateJson(
        opts.llm,
        {
          system: PHASE2_SYSTEM,
          parts: [
            { type: 'text', text: `<structure>\n${JSON.stringify(structure)}\n</structure>` },
            {
              type: 'text',
              text: `<headings>\n${[...contextLines, ...win.map(({ i }) => outline[i] as string)].join('\n')}\n</headings>`,
            },
          ],
          maxOutputTokens: 4096,
          effort: 'medium',
          signal: opts.signal,
        },
        correctionsSchema,
        'heading_corrections',
      )
      addUsage(usage, res.usage)
      const allowed = new Set(win.map(({ i }) => i))
      for (const c of res.value.corrections) {
        const h = headings[c.id]
        if (h && allowed.has(c.id) && c.level !== h.level) changes.set(h.line, c.level)
      }
    } catch (err) {
      if (isFatal(err)) throw err
      opts.reporter.warn(
        'structure',
        `Heading window ${w + 1}/${windows.length} skipped: ${(err as Error).message}`,
      )
    }
    w++
  }
  opts.reporter.progress('structure', windows.length, windows.length)

  await opts.cache.set('structure', key, { changes: [...changes], documentType: structure.documentType })
  const final = harmonizeNumberedHeadings(headings, changes)
  return {
    ...base,
    markdown: applyHeadingLevels(markdown, final, headings),
    corrections: final.size,
    documentType: structure.documentType,
    skipped: null,
  }
}

/** Configuration and connectivity problems stop the run; content problems only skip work. */
export function isFatal(err: unknown): boolean {
  if (!(err instanceof RagChunkerError)) return false
  return [
    'MISSING_API_KEY',
    'MODEL_NOT_FOUND',
    'PROVIDER_UNAVAILABLE',
    'CAPABILITY_MISSING',
    'CONFIG_INVALID',
    'ABORTED',
    'OPTIONAL_DEPENDENCY_MISSING',
  ].includes(err.code)
}
