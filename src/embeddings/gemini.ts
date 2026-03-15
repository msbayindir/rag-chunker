import { GoogleGenAI } from '@google/genai'
import type { IEmbeddingProvider } from './types.js'

/**
 * Creates an embedding provider using Gemini embedding-001 model.
 * Produces 1536-dimensional vectors for RETRIEVAL_DOCUMENT task type.
 */
export function createGeminiEmbeddingProvider(
  opts: { apiKey: string }
): IEmbeddingProvider {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  return {
    providerName: 'gemini',
    dimensions: 1536,
    async embed(texts: string[]): Promise<number[][]> {
      const results: number[][] = []
      for (const text of texts) {
        const result = await ai.models.embedContent({
          model: 'gemini-embedding-001',
          contents: [text],
          config: {
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: 1536
          }
        })
        results.push(result.embeddings![0]!.values!)
      }
      return results
    }
  }
}
