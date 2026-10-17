import type { CacheStore } from '../cache/store.js'
import { getTokenizer } from '../chunker/tokenizer.js'
import type { Reporter } from '../pipeline/events.js'
import { addUsage, type Embedder, type EmbeddingKind, emptyUsage, type Usage } from '../providers/types.js'
import { batches, mapPool } from '../util/async.js'
import { sha256 } from '../util/hash.js'

export interface EmbedOptions {
  embedder: Embedder
  kind: EmbeddingKind
  cache: CacheStore
  dimensions?: number
  concurrency?: number
  reporter?: Reporter
  signal?: AbortSignal
}

export interface EmbedResult {
  vectors: number[][]
  /** Texts that were cut to fit the model's input limit. */
  truncated: number
  cached: number
  dimensions: number
  usage: Usage
}

/**
 * Model tokenizers differ from o200k (most need more tokens for non-English text),
 * so inputs are cut with a safety margin.
 */
const SAFETY = 0.8

/** Embeds texts with batching, caching and input-length protection. Output order matches input. */
export async function embedTexts(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
  const usage = emptyUsage()
  const tok = getTokenizer('o200k')
  const limit = Math.floor((await opts.embedder.maxInputTokens()) * SAFETY)
  let truncated = 0
  const inputs = texts.map((t) => {
    if (tok.count(t) <= limit) return t
    truncated++
    return tok.truncate(t, limit)
  })

  const vectors: number[][] = new Array(texts.length)
  const keyOf = (text: string) =>
    opts.cache.key('embedding', opts.embedder.ref, opts.dimensions ?? 0, opts.kind, sha256(text))
  const pending: number[] = []
  let cached = 0
  for (let i = 0; i < inputs.length; i++) {
    const hit = await opts.cache.get<number[]>('embedding', keyOf(inputs[i] as string))
    if (hit !== undefined) {
      vectors[i] = hit
      cached++
    } else {
      pending.push(i)
    }
  }

  let done = cached
  opts.reporter?.progress('embedding', done, texts.length, opts.embedder.ref)
  await mapPool(
    batches(pending, opts.embedder.batchSize),
    opts.concurrency ?? opts.embedder.provider.concurrency,
    async (idx) => {
      const res = await opts.embedder.embed(
        idx.map((i) => inputs[i] as string),
        opts.kind,
        opts.signal,
      )
      addUsage(usage, res.usage)
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j] as number
        const v = res.vectors[j] as number[]
        vectors[i] = v
        await opts.cache.set('embedding', keyOf(inputs[i] as string), v)
      }
      done += idx.length
      opts.reporter?.progress('embedding', done, texts.length, opts.embedder.ref)
    },
    opts.signal,
  )

  if (truncated > 0) {
    opts.reporter?.warn(
      'embedding',
      `${truncated} text(s) were longer than ${opts.embedder.ref} accepts and were truncated for embedding.`,
    )
  }
  return { vectors, truncated, cached, dimensions: vectors[0]?.length ?? 0, usage }
}
