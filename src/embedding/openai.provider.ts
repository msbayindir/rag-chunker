import type { IEmbeddingProvider } from './types.js'

// Minimal interface for the subset of OpenAI client we use
// Avoids importing from 'openai' at compile time (optional peer dependency)
interface OpenAIEmbeddingClient {
  embeddings: {
    create(params: { model: string; input: string[] }): Promise<{
      data: Array<{ embedding: number[] }>
    }>
  }
}

type OpenAIConstructor = new (opts: { apiKey: string }) => OpenAIEmbeddingClient

let client: OpenAIEmbeddingClient | null = null

async function getClient(apiKey: string): Promise<OpenAIEmbeddingClient> {
  if (client) return client
  let ctor: OpenAIConstructor
  try {
    // @ts-expect-error openai is an optional peer dependency — may not be installed
    const mod = await import('openai') as Record<string, unknown>
    ctor = (mod['default'] ?? mod['OpenAI']) as OpenAIConstructor
  } catch {
    throw new Error(
      '[rag-chunker] openai paketi bulunamadı. Kurmak için: npm install openai'
    )
  }
  client = new ctor({ apiKey })
  return client
}

/**
 * Creates an embedding provider using OpenAI text-embedding-3-large model.
 * Produces 3072-dimensional vectors. Requires openai package as peer dependency.
 */
export function createOpenAiEmbeddingProvider(
  opts: { apiKey: string }
): IEmbeddingProvider {
  return {
    providerName: 'openai',
    dimensions: 3072,
    async embed(texts: string[]): Promise<number[][]> {
      const c = await getClient(opts.apiKey)
      const response = await c.embeddings.create({
        model: 'text-embedding-3-large',
        input: texts
      })
      return response.data.map(d => d.embedding)
    }
  }
}
