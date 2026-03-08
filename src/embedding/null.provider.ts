import type { IEmbeddingProvider } from './types.js'

/**
 * Null object pattern embedding provider.
 * Returns empty vectors for all inputs. Useful for testing or when embeddings are not needed.
 */
export function createNullEmbeddingProvider(): IEmbeddingProvider {
  return {
    providerName: 'null',
    dimensions: 0,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [])
    }
  }
}
