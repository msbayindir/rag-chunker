# @msbayindir/rag-chunker

Semantically splits PDFs into context-enriched chunks for RAG pipelines — powered by Gemini.

Implements Anthropic's [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) approach: each chunk is accompanied by a 2-sentence summary explaining its role in the full document, dramatically improving retrieval precision.

---

## Features

- **Semantic chunking** — Gemini reads the full document context and determines meaningful chunk boundaries (no fixed token splits)
- **Contextual summaries** — each chunk gets a 2-sentence context explaining its place in the whole document
- **Context caching** — the full PDF is cached in Gemini's context cache, shared across all chunk and summary calls
- **Cache registry** — local JSON registry reuses Gemini file uploads and caches across runs of the same PDF
- **Multi-model support** — use a Pro model for chunking and a Flash model for summaries
- **Batch context mode** — summarize N chunks in a single API call (up to 10x fewer calls)
- **Optional embeddings** — built-in providers for Gemini, OpenAI, or bring your own
- **Concurrency control** — sliding window pool with per-item delays for rate limit safety
- **Abort & timeout** — `AbortSignal` and `timeoutMs` support

---

## Installation

```bash
npm install @msbayindir/rag-chunker @google/genai
```

OpenAI embedding provider (optional):
```bash
npm install openai
```

---

## Quick Start

```typescript
import { readFileSync } from 'fs'
import { chunk } from '@msbayindir/rag-chunker'

const pdf = readFileSync('./document.pdf')

const result = await chunk(pdf, {
  geminiApiKey: process.env.GEMINI_API_KEY!,
  geminiModel: 'gemini-2.0-flash',
})

for (const c of result.chunks) {
  console.log(`Chunk #${c.chunkIndex} — pages ${c.pageRange.start}–${c.pageRange.end}`)
  console.log(`Context: ${c.contextSummary}`)
  console.log(`Text:    ${c.text.slice(0, 120)}`)
}
```

---

## Context Modes

### per-chunk (default)
One API call per chunk. Best quality.

```typescript
chunk(pdf, {
  geminiApiKey,
  geminiModel: 'gemini-2.0-flash',
  // contextMode: 'per-chunk' is the default
})
```

100 chunks → 7 group calls + 100 context calls = **107 API calls**

### batch
N chunks summarized in a single API call.

```typescript
chunk(pdf, {
  geminiApiKey,
  geminiModel: 'gemini-2.0-flash',
  contextMode: 'batch',
  contextBatchSize: 10,
})
```

100 chunks → 7 group calls + 10 batch calls = **17 API calls**

### skipContext
No context summaries. Fastest, cheapest.

```typescript
chunk(pdf, {
  geminiApiKey,
  geminiModel: 'gemini-2.0-flash',
  skipContext: true,
})
```

100 chunks → 7 group calls = **7 API calls**

### Multi-model
Use a high-quality model for chunking, a cheap model for summaries.

```typescript
chunk(pdf, {
  geminiApiKey,
  chunkModel: 'gemini-2.5-pro',
  contextModel: 'gemini-2.0-flash',
  contextMode: 'batch',
  contextBatchSize: 10,
})
```

Two separate context caches are created — one per model.

---

## Embeddings

```typescript
import { createGeminiEmbeddingProvider } from '@msbayindir/rag-chunker'

chunk(pdf, {
  geminiApiKey,
  geminiModel: 'gemini-2.0-flash',
  embeddingProvider: createGeminiEmbeddingProvider({ apiKey: geminiApiKey }),
})
// Each ChunkResult.embedding → number[] (1536 dims)
```

```typescript
import { createOpenAiEmbeddingProvider } from '@msbayindir/rag-chunker'

chunk(pdf, {
  geminiApiKey,
  geminiModel: 'gemini-2.0-flash',
  embeddingProvider: createOpenAiEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY! }),
})
```

---

## Cache Registry

On the first run with a given PDF, the library uploads the file and creates a context cache. On subsequent runs with the same PDF (identified by SHA-256 content hash), both are reused from a local JSON registry — saving ~10s upload time and cache creation cost.

```
~/.rag-chunker/registry.json   ← default location
```

```typescript
// Custom path
chunk(pdf, { geminiApiKey, cacheRegistry: './my-project/cache.json' })

// Disable registry
chunk(pdf, { geminiApiKey, cacheRegistry: false })
```

File entries expire after 47h (Gemini's 48h TTL with a safety buffer). Cache entries expire per the API-returned `expireTime`. Expired entries are pruned automatically on load.

---

## Full Config Reference

```typescript
interface ChunkerConfig {
  geminiApiKey: string

  // Models
  geminiModel?: string          // default: 'gemini-1.5-pro'
  chunkModel?: string           // override for chunk determination step
  contextModel?: string         // override for context summary step

  // PDF processing
  groupSize?: number            // pages per group, default: 15
  pageRange?: { start: number; end: number }  // 1-based, inclusive
  maxPages?: number

  // Concurrency & rate limiting
  maxConcurrentGroups?: number  // default: 3
  maxConcurrentChunks?: number  // default: 3
  perGroupDelayMs?: number      // default: 300
  perChunkDelayMs?: number      // default: 500

  // Chunking
  maxChunkChars?: number        // default: 3000 (~750 tokens)

  // Context summary
  skipContext?: boolean         // default: false
  contextMode?: 'per-chunk' | 'batch'  // default: 'per-chunk'
  contextBatchSize?: number     // default: 10 (batch mode only)

  // Registry
  cacheRegistry?: string | false  // default: ~/.rag-chunker/registry.json

  // Abort / timeout
  timeoutMs?: number
  abortSignal?: AbortSignal

  // Embedding
  embeddingProvider?: IEmbeddingProvider

  // Logging
  logger?: ILogger
}
```

---

## ChunkResult

```typescript
interface ChunkResult {
  chunkIndex: number
  pageRange: { start: number; end: number }
  text: string
  contextSummary: string        // '' if skipContext or failed
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  embedding?: number[]          // only if embeddingProvider is set
  status: 'success' | 'partial' | 'error' | 'timeout'
  failedSteps?: Array<'context' | 'embedding'>
}
```

---

## Custom Logger

```typescript
import { chunk, createDefaultLogger } from '@msbayindir/rag-chunker'
import type { ILogger } from '@msbayindir/rag-chunker'

// Use your own logger
const myLogger: ILogger = {
  debug: (msg, meta) => myLib.debug(meta, msg),
  info:  (msg, meta) => myLib.info(meta, msg),
  warn:  (msg, meta) => myLib.warn(meta, msg),
  error: (msg, meta) => myLib.error(meta, msg),
}

chunk(pdf, { geminiApiKey, logger: myLogger })
```

---

## Requirements

- Node.js >= 20
- `@google/genai` >= 1.44.0 (peer dependency)
- `openai` >= 4.0.0 (optional peer dependency, for OpenAI embedding provider)

---

## License

MIT

---

---

# Türkçe

## Nedir?

PDF'leri RAG pipeline'ları için anlamlı parçalara bölen bir kütüphane. Gemini API kullanır ve Anthropic'in *Contextual Retrieval* yaklaşımını uygular: her chunk, tüm dokümandaki bağlamını açıklayan 2 cümlelik bir özetle zenginleştirilir.

## Kurulum

```bash
npm install @msbayindir/rag-chunker @google/genai
```

## Temel Kullanım

```typescript
import { readFileSync } from 'fs'
import { chunk } from '@msbayindir/rag-chunker'

const pdf = readFileSync('./belge.pdf')

const result = await chunk(pdf, {
  geminiApiKey: process.env.GEMINI_API_KEY!,
  geminiModel: 'gemini-2.0-flash',
})

for (const c of result.chunks) {
  console.log(`Chunk #${c.chunkIndex} — sayfa ${c.pageRange.start}–${c.pageRange.end}`)
  console.log(`Bağlam: ${c.contextSummary}`)
  console.log(`Metin:  ${c.text.slice(0, 120)}`)
}
```

## Context Modları

| Mod | Açıklama | API Çağrısı (100 chunk) |
|-----|----------|-------------------------|
| `per-chunk` (varsayılan) | Her chunk için ayrı çağrı | 107 |
| `batch` | N chunk tek çağrıda | 17 |
| `skipContext: true` | Context üretme | 7 |

## Cache Registry

Aynı PDF her çalıştırıldığında yeniden upload ve cache oluşturmayı önler. İçerik bazlı SHA-256 ile PDF'i tanır, sonuçları `~/.rag-chunker/registry.json` dosyasına kaydeder.

## Embedding Sağlayıcıları

- `createGeminiEmbeddingProvider` — gemini-embedding-001, 1536 boyut
- `createOpenAiEmbeddingProvider` — text-embedding-3-small (varsayılan)
- `createNullEmbeddingProvider` — test için boş sağlayıcı
