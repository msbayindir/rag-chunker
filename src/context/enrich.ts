import { z } from 'zod'
import type { CacheStore } from '../cache/store.js'
import type { ChunkDraft, Section } from '../chunker/chunker.js'
import { splitToBudget } from '../chunker/split.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import type { Reporter } from '../pipeline/events.js'
import { generateJson } from '../providers/structured.js'
import { addUsage, emptyUsage, type LLM, type Usage } from '../providers/types.js'
import { isFatal } from '../structure/heading-fix.js'
import { mapPool } from '../util/async.js'
import { sha256 } from '../util/hash.js'

const PROMPT_VERSION = 'v2'
const MAX_SUMMARY_CHARS = 600
/**
 * "auto" sends the whole document only up to this size. Above it every request would carry a huge
 * prefix: slow, expensive even with caching, and quickly over per-minute token quotas.
 */
export const FULL_STRATEGY_MAX_TOKENS = 60_000

export type ContextStrategy = 'full' | 'hierarchical'

export interface ContextOptions {
  llm: LLM
  strategy: 'auto' | 'full' | 'hierarchical'
  batchSize: number
  concurrency?: number
  cache: CacheStore
  reporter: Reporter
  signal?: AbortSignal
}

export interface ContextResult {
  summaries: string[]
  strategy: ContextStrategy
  enriched: number
  skipped: number
  failed: number
  cached: number
  usage: Usage
}

const itemsSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.number().int(), context: z.string() })),
})
const summarySchema = z.strictObject({ summary: z.string() })

const CHUNK_SYSTEM = `You write contextual-retrieval notes for chunks of a document.
For every chunk, write 1-2 sentences (at most ~50 words) that situate it within the document: which section and topic it belongs to and what role it plays, so a search engine can match it to questions about that topic.
Rules:
- Write in the same language as the document.
- Do not repeat the chunk word for word and do not invent facts.
- No preamble, no labels.
Return {"items":[{"id":<chunk id>,"context":"..."}]} with exactly one item per chunk id.`

const SECTION_SYSTEM = `Summarise the given part of a document in 2-4 sentences: its topic, the key entities and its purpose. Write in the same language as the text. No preamble. Return {"summary":"..."}.`

const DOCUMENT_SYSTEM = `You get the sections of one document in order: each title, followed by a summary for longer sections. Summarise the whole document in 3-5 sentences: what it is, who it is for and what it covers. Write in the same language as the sections. Return {"summary":"..."}.`

const MARKER_RE = /<!--\s*page\s+\d+\s*-->\n*/gi

/** Very short or symbol-heavy chunks (OCR noise, figure debris) get no context. Numeric tables do. */
export function isLowQuality(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 40) return true
  const meaningful = (t.match(/[\p{L}\p{N}]/gu) ?? []).length
  return meaningful / t.length < 0.45
}

function clampSummary(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= MAX_SUMMARY_CHARS) return t
  const cut = t.slice(0, MAX_SUMMARY_CHARS)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > 100 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`
}

function chunkBlock(chunks: Array<{ id: number; draft: ChunkDraft }>): string {
  return chunks
    .map(({ id, draft }) => {
      const section = draft.sectionPath.join(' > ') || '(none)'
      const pages =
        draft.pageStart === draft.pageEnd ? `${draft.pageStart}` : `${draft.pageStart}-${draft.pageEnd}`
      return `<chunk id="${id}" section="${section.replace(/"/g, "'")}" pages="${pages}">\n${draft.text}\n</chunk>`
    })
    .join('\n')
}

interface Plan {
  strategy: ContextStrategy
  prefix: string
  /** Extra text per chunk group (hierarchical: section summary). */
  groupNotes: Map<number, string>
}

/** Adds Anthropic-style contextual summaries to chunks. Content failures become warnings, never crashes. */
export async function enrichChunks(
  input: { markdown: string; chunks: ChunkDraft[]; sections: Section[] },
  opts: ContextOptions,
): Promise<ContextResult> {
  const usage = emptyUsage()
  const tok = getTokenizer('o200k')
  const summaries: string[] = new Array(input.chunks.length).fill('')
  const caps = await opts.llm.capabilities()
  const docText = input.markdown.replace(MARKER_RE, '').trim()
  const docTokens = tok.count(docText)
  const maxChunk = input.chunks.reduce((m, c) => Math.max(m, c.tokenCount), 0)
  const batchTokens = opts.batchSize * (maxChunk + 30)
  const prefixBudget = caps.contextWindow - batchTokens - opts.batchSize * 160 - 2500

  let strategy: ContextStrategy
  if (opts.strategy === 'full' && docTokens > prefixBudget) {
    opts.reporter.warn(
      'context',
      `The document (${docTokens} tokens) does not fit ${opts.llm.ref} (${caps.contextWindow} tokens); using the hierarchical strategy.`,
    )
    strategy = 'hierarchical'
  } else if (opts.strategy === 'auto') {
    strategy = docTokens <= Math.min(prefixBudget * 0.9, FULL_STRATEGY_MAX_TOKENS) ? 'full' : 'hierarchical'
  } else {
    strategy = opts.strategy
  }

  const plan: Plan =
    strategy === 'full'
      ? { strategy, prefix: `<document>\n${docText}\n</document>`, groupNotes: new Map() }
      : await hierarchicalPlan(
          input.sections,
          input.chunks,
          opts,
          Math.max(2000, Math.floor(caps.contextWindow * 0.5)),
          usage,
        )

  const sectionPaths = new Map(input.sections.map((s) => [s.group, s.path]))
  const eligible = input.chunks
    .map((draft, id) => ({ id, draft }))
    .filter(({ draft }) => draft.mustPreserve || !isLowQuality(draft.text))
  const skipped = input.chunks.length - eligible.length
  const prefixHash = sha256(plan.prefix)
  const keyOf = (id: number, draft: ChunkDraft) =>
    opts.cache.key(
      'context',
      PROMPT_VERSION,
      opts.llm.ref,
      plan.strategy,
      prefixHash,
      sha256(plan.groupNotes.get(draft.group) ?? ''),
      draft.sectionPath,
      sha256(draft.text),
      id > 0 ? sha256(input.chunks[id - 1]?.text ?? '') : '',
    )

  let cached = 0
  const pending: Array<{ id: number; draft: ChunkDraft }> = []
  for (const item of eligible) {
    const hit = await opts.cache.get<string>('context', keyOf(item.id, item.draft))
    if (hit !== undefined) {
      summaries[item.id] = hit
      cached++
    } else {
      pending.push(item)
    }
  }

  // Batches are runs of consecutive chunks. They may span sections (each chunk carries its section
  // path and, in hierarchical mode, every section in the batch gets its summary), so documents with
  // many short sections still use full batches.
  const groups: Array<Array<{ id: number; draft: ChunkDraft }>> = []
  for (const item of pending) {
    const last = groups.at(-1)
    const lastItem = last?.at(-1)
    if (last && lastItem && last.length < opts.batchSize && lastItem.id === item.id - 1) {
      last.push(item)
    } else {
      groups.push([item])
    }
  }

  let failed = 0
  let done = cached
  const total = eligible.length
  opts.reporter.progress('context', done, total, plan.strategy)

  const runBatch = async (batch: Array<{ id: number; draft: ChunkDraft }>): Promise<void> => {
    const first = batch[0] as { id: number; draft: ChunkDraft }
    const parts: Array<{ type: 'text'; text: string }> = []
    const seen = new Set<number>()
    for (const { draft } of batch) {
      if (seen.has(draft.group)) continue
      seen.add(draft.group)
      const note = plan.groupNotes.get(draft.group)
      if (!note) continue
      const path = (sectionPaths.get(draft.group) ?? draft.sectionPath).join(' > ').replace(/"/g, "'")
      parts.push({ type: 'text', text: `<section_summary path="${path}">\n${note}\n</section_summary>` })
    }
    if (plan.strategy === 'hierarchical') {
      const before = input.chunks[first.id - 1]
      if (before && before.group === first.draft.group) {
        parts.push({ type: 'text', text: `<text_before>\n${tailTokens(before.text, 200)}\n</text_before>` })
      }
    }
    parts.push({ type: 'text', text: `<chunks>\n${chunkBlock(batch)}\n</chunks>` })
    try {
      const res = await generateJson(
        opts.llm,
        {
          system: CHUNK_SYSTEM,
          prefix: plan.prefix,
          parts,
          maxOutputTokens: batch.length * 300 + 1024,
          effort: 'low',
          signal: opts.signal,
        },
        itemsSchema,
        'chunk_contexts',
      )
      addUsage(usage, res.usage)
      const wanted = new Set(batch.map((b) => b.id))
      const got = new Map<number, string>()
      for (const item of res.value.items) {
        const text = clampSummary(item.context)
        if (wanted.has(item.id) && text !== '' && !got.has(item.id)) got.set(item.id, text)
      }
      for (const b of batch) {
        const text = got.get(b.id)
        if (!text) continue
        summaries[b.id] = text
        await opts.cache.set('context', keyOf(b.id, b.draft), text)
        done++
      }
      opts.reporter.progress('context', done, total, plan.strategy)
      const missing = batch.filter((b) => !got.has(b.id))
      if (missing.length > 0 && batch.length > 1) {
        for (const m of missing) await runBatch([m])
      } else if (missing.length > 0) {
        failed++
        opts.reporter.warn('context', `No context returned for chunk ${first.id}`)
      }
    } catch (err) {
      if (isFatal(err)) throw err
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2)
        await runBatch(batch.slice(0, mid))
        await runBatch(batch.slice(mid))
        return
      }
      failed++
      opts.reporter.warn('context', `Context for chunk ${first.id} failed: ${(err as Error).message}`)
    }
  }

  if (groups.length > 0) {
    // The first request runs alone so prompt caches are warm before the parallel requests start.
    await runBatch(groups[0] as Array<{ id: number; draft: ChunkDraft }>)
    await mapPool(groups.slice(1), opts.concurrency ?? opts.llm.provider.concurrency, runBatch, opts.signal)
  }
  opts.reporter.progress('context', total, total, plan.strategy)

  return {
    summaries,
    strategy: plan.strategy,
    enriched: summaries.filter((s) => s !== '').length,
    skipped,
    failed,
    cached,
    usage,
  }
}

function tailTokens(text: string, tokens: number): string {
  const tok = getTokenizer('o200k')
  const words = text.split(/(?<=\s)/)
  let out = ''
  for (let i = words.length - 1; i >= 0; i--) {
    const next = (words[i] as string) + out
    if (tok.count(next) > tokens) break
    out = next
  }
  return out.trim()
}

async function summarize(
  text: string,
  system: string,
  name: string,
  opts: ContextOptions,
  usage: Usage,
): Promise<string> {
  const key = opts.cache.key('summary', PROMPT_VERSION, opts.llm.ref, name, sha256(text))
  const hit = await opts.cache.get<string>('summary', key)
  if (hit !== undefined) return hit
  const res = await generateJson(
    opts.llm,
    { system, parts: [{ type: 'text', text }], maxOutputTokens: 1024, effort: 'low', signal: opts.signal },
    summarySchema,
    name,
  )
  addUsage(usage, res.usage)
  const summary = clampSummary(res.value.summary)
  await opts.cache.set('summary', key, summary)
  return summary
}

/**
 * Section summaries (map-reduce for long sections) and a document summary built from them. A
 * section that fits in one chunk gets no summary of its own (the chunk is the whole section), only
 * its title in the document summary input. Documents made of many short sections (laws, FAQs)
 * would otherwise need one extra request per section.
 */
async function hierarchicalPlan(
  sections: Section[],
  chunks: ChunkDraft[],
  opts: ContextOptions,
  budget: number,
  usage: Usage,
): Promise<Plan> {
  const tok = getTokenizer('o200k')
  const groupNotes = new Map<number, string>()
  const chunksPerGroup = new Map<number, number>()
  for (const c of chunks) chunksPerGroup.set(c.group, (chunksPerGroup.get(c.group) ?? 0) + 1)
  const toSummarize = sections.filter((s) => s.text.trim() !== '' && (chunksPerGroup.get(s.group) ?? 0) > 1)
  let done = 0
  opts.reporter.progress('context', 0, toSummarize.length, 'summarising sections')
  await mapPool(
    toSummarize,
    opts.concurrency ?? opts.llm.provider.concurrency,
    async (section) => {
      const title = section.path.join(' > ')
      const body = section.text.trim()
      try {
        let summary: string
        if (tok.count(body) <= budget) {
          summary = await summarize(
            `${title ? `${title}\n\n` : ''}${body}`,
            SECTION_SYSTEM,
            'section_summary',
            opts,
            usage,
          )
        } else {
          const partSummaries: string[] = []
          for (const part of splitToBudget(body, budget, tok)) {
            partSummaries.push(await summarize(part, SECTION_SYSTEM, 'section_summary', opts, usage))
          }
          summary = await summarize(
            `${title}\n\n${partSummaries.join('\n')}`,
            SECTION_SYSTEM,
            'section_summary',
            opts,
            usage,
          )
        }
        groupNotes.set(section.group, summary)
      } catch (err) {
        if (isFatal(err)) throw err
        opts.reporter.warn(
          'context',
          `Section summary failed for "${title || 'untitled'}": ${(err as Error).message}`,
        )
      }
      done++
      opts.reporter.progress('context', done, toSummarize.length, 'summarising sections')
    },
    opts.signal,
  )
  const ordered = sections
    .filter((s) => groupNotes.has(s.group) || s.path.length > 0)
    .map((s) => {
      const note = groupNotes.get(s.group)
      const title = s.path.join(' > ') || 'Introduction'
      return note ? `- ${title}: ${note}` : `- ${title}`
    })
  let docSummary = ''
  if (ordered.length > 0) {
    try {
      docSummary = await summarize(
        tok.truncate(ordered.join('\n'), budget),
        DOCUMENT_SYSTEM,
        'document_summary',
        opts,
        usage,
      )
    } catch (err) {
      if (isFatal(err)) throw err
      opts.reporter.warn('context', `Document summary failed: ${(err as Error).message}`)
    }
  }
  return {
    strategy: 'hierarchical',
    prefix: `<document_summary>\n${docSummary || '(not available)'}\n</document_summary>`,
    groupNotes,
  }
}
