import type { Chunk } from '../types.js'
import { sha256 } from '../util/hash.js'
import type { ChunkDraft } from './chunker.js'

/** Builds the text that gets embedded. */
export function buildContent(contextSummary: string, overlap: string, rawContent: string): string {
  const parts: string[] = []
  if (contextSummary.trim() !== '') parts.push(`Context: ${contextSummary.trim()}`)
  if (overlap.trim() !== '') parts.push(overlap.trim())
  parts.push(rawContent)
  return parts.join('\n\n')
}

/** Stable, collision-free ids: document prefix + content hash, with a suffix for repeated content. */
export function assignChunkIds(drafts: readonly ChunkDraft[], documentId: string): string[] {
  const seen = new Map<string, number>()
  return drafts.map((d) => {
    const base = `${documentId.slice(0, 12)}-${sha256(d.text).slice(0, 16)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}

export interface FinalizeInput {
  drafts: readonly ChunkDraft[]
  documentId: string
  source: string
  /** Page number → engine that produced it. */
  pageSources: ReadonlyMap<number, string>
  defaultSource: string
  contextSummaries?: readonly string[]
  countTokens: (text: string) => number
}

export function finalizeChunks(input: FinalizeInput): Chunk[] {
  const ids = assignChunkIds(input.drafts, input.documentId)
  return input.drafts.map((d, index) => {
    const contextSummary = input.contextSummaries?.[index] ?? ''
    const content = buildContent(contextSummary, d.overlap, d.text)
    const sources = new Set<string>()
    for (let p = d.pageStart; p <= d.pageEnd; p++) {
      sources.add(input.pageSources.get(p) ?? input.defaultSource)
    }
    return {
      chunkId: ids[index] as string,
      documentId: input.documentId,
      source: input.source,
      index,
      content,
      rawContent: d.text,
      contextSummary,
      tokenCount: input.countTokens(content),
      contentType: d.contentType,
      sectionPath: d.sectionPath,
      pageStart: d.pageStart,
      pageEnd: d.pageEnd,
      ocrSource: [...sources].join(','),
      boxes: [],
      prevChunkId: index > 0 ? (ids[index - 1] as string) : null,
      nextChunkId: index < ids.length - 1 ? (ids[index + 1] as string) : null,
      mustPreserve: d.mustPreserve,
      embedding: [],
    }
  })
}
