import { createRequire } from 'node:module'
import type { ResolvedConfig } from '../config/schema.js'
import type { DocumentKind } from '../documents/input.js'
import type { Usage } from '../providers/types.js'
import type { Chunk, ContentType } from '../types.js'

const require = createRequire(import.meta.url)
export const PACKAGE_VERSION: string = (require('../../package.json') as { version: string }).version

export interface Manifest {
  /** rag-chunker version that produced the output. */
  version: string
  createdAt: string
  durationMs: number
  source: { name: string; documentId: string; kind: DocumentKind; bytes: number }
  /** Configuration used (API keys removed). */
  config: ResolvedConfig
  stages: {
    ocr: {
      engine: string
      model: string
      pages: number
      textLayerPages: number
      ocrPages: number
      cachedPages: number
      scannedPages: number
      emptyPages: number
      headerFooterLinesRemoved: number
      durationMs: number
    }
    structure: {
      model: string
      headings: number
      corrections: number
      documentType: string | null
      skipped: string | null
      cached: boolean
      durationMs: number
    } | null
    chunk: {
      tokenizer: string
      count: number
      avgTokens: number
      minTokens: number
      maxTokens: number
      byType: Record<ContentType, number>
      durationMs: number
    }
    context: {
      model: string
      strategy: string
      enriched: number
      skipped: number
      failed: number
      cached: number
      durationMs: number
    } | null
    embedding: {
      model: string
      dimensions: number
      truncated: number
      cached: number
      durationMs: number
    } | null
  }
  usage: { total: Usage; byStage: Record<string, Usage> }
  warnings: string[]
}

export function sanitizeConfig(config: ResolvedConfig): ResolvedConfig {
  const providers: ResolvedConfig['providers'] = {}
  for (const [name, p] of Object.entries(config.providers)) {
    const { apiKey: _drop, ...rest } = p
    providers[name] = rest
  }
  return { ...config, providers }
}

export function chunkStats(chunks: Chunk[]): Omit<Manifest['stages']['chunk'], 'tokenizer' | 'durationMs'> {
  const tokens = chunks.map((c) => c.tokenCount)
  const byType: Record<ContentType, number> = { text: 0, table: 0, code: 0, mixed: 0 }
  for (const c of chunks) byType[c.contentType]++
  return {
    count: chunks.length,
    avgTokens: chunks.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / chunks.length) : 0,
    minTokens: chunks.length ? Math.min(...tokens) : 0,
    maxTokens: chunks.length ? Math.max(...tokens) : 0,
    byType,
  }
}
