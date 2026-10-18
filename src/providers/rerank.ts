import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import type { Reranker } from '../search/search.js'
import { requestJson } from './http.js'

/**
 * Hosted rerankers behind one shape: Cohere (`cohere/rerank-v3.5`) and Jina
 * (`jina/jina-reranker-v2-base-multilingual`). Both take a query and a list of documents and
 * answer with a relevance score per document index, so one client covers them.
 */

interface RerankResponse {
  results: Array<{ index: number; relevance_score: number }>
}

/** Documents longer than this are cut: hosted rerankers bill by token and cap the input. */
const MAX_DOC_CHARS = 4000

export function createApiReranker(ref: string, model: string, provider: ResolvedProvider): Reranker {
  if (provider.type !== 'cohere' && provider.type !== 'jina') {
    throw new RagChunkerError('CAPABILITY_MISSING', `${ref} cannot rerank`, {
      hint: 'Reranking providers: cohere (COHERE_API_KEY), jina (JINA_API_KEY), or a local model (rerank.engine).',
    })
  }
  const url = `${(provider.baseURL ?? '').replace(/\/$/, '')}/rerank`
  return {
    id: ref,
    async score(query, texts, signal) {
      if (texts.length === 0) return []
      const res = await requestJson<RerankResponse>(url, {
        headers: { Authorization: `Bearer ${provider.apiKey ?? ''}`, ...provider.headers },
        body: {
          model,
          query,
          documents: texts.map((t) => t.slice(0, MAX_DOC_CHARS)),
          top_n: texts.length,
          ...(provider.type === 'jina' ? { return_documents: false } : {}),
        },
        timeoutMs: provider.timeoutMs,
        maxRetries: provider.maxRetries,
        signal,
      })
      const scores = new Array<number>(texts.length).fill(0)
      for (const r of res?.results ?? []) {
        if (Number.isInteger(r.index) && r.index >= 0 && r.index < texts.length)
          scores[r.index] = r.relevance_score
      }
      return scores
    },
  }
}
