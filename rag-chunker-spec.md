# rag-chunker — Technical Specification

## Overview

`@msbayindir/rag-chunker` is a PDF chunking library for RAG (Retrieval-Augmented Generation) pipelines. It uses the Gemini API to semantically split PDFs into contextually enriched chunks, following Anthropic's *Contextual Retrieval* approach.

---

## Architecture

```
PDF Buffer
    │
    ├─ [Registry] findFileRef → hit? skip upload
    │
    ▼
Step 1: uploadPdf()           → Gemini File API  (48h TTL)
    │
    ├─ [Registry] findCacheRef → hit? skip createCache
    │
    ▼
Step 2: createCache()         → Gemini Caching API  (24h TTL, model-bound)
    │
    ▼
Step 3: splitIntoGroups()     → pdf-lib: slice into N-page buffers
    │
    ▼
Step 4: determineChunks()     → Gemini: semantic boundaries per group  [pool]
    │
    ▼
Step 5: generateContext()     → Gemini: 2-sentence context summary per chunk  [pool]
    │
    ▼
Step 6: embed()               → Embedding provider (optional)
    │
    ▼
ChunkerResult
```

Steps 2, 3, and (if needed) the context-model cache run in parallel via `Promise.all`.

---

## Module Map

```
src/
├── index.ts                  Main pipeline orchestrator
├── types.ts                  All public types
├── logger.ts                 ILogger interface + pino wrapper
│
├── gemini/
│   ├── file-upload.ts        uploadPdf() — Gemini Files API
│   ├── context-cache.ts      createCache() — Gemini Caching API (TTL=86400s)
│   ├── llm-caller.ts         callWithRetry(), extractJson()
│   └── registry.ts           Local JSON registry for file/cache reuse
│
├── pdf/
│   ├── page-splitter.ts      splitIntoGroups() — pdf-lib page slicing
│   └── chunk-determiner.ts   determineChunks() — Gemini semantic splitting
│
├── context/
│   └── summarizer.ts         generateContext(), generateContextBatch()
│
├── embedding/
│   ├── types.ts              IEmbeddingProvider interface
│   ├── gemini.provider.ts    gemini-embedding-001, 1536-dim, RETRIEVAL_DOCUMENT
│   ├── openai.provider.ts    text-embedding-3-small (or configurable)
│   └── null.provider.ts      No-op provider for testing
│
└── pipeline/
    └── pool.ts               processWithPool() — sliding window concurrency
```

---

## Step Details

### Step 1 — PDF Upload (`file-upload.ts`)

- Uploads the PDF buffer to Gemini File API as a `Blob`.
- Returns `FileRef { name, uri, mimeType }`.
- Gemini retains the file for 48 hours.
- Registry bypass: if `findFileRef()` returns a hit, upload is skipped entirely.

### Step 2 — Context Cache (`context-cache.ts`)

- Creates a Gemini context cache containing the uploaded PDF.
- TTL: `86400s` (24 hours).
- Cache is **model-bound** — different models require separate caches.
- Returns `CacheRef { name, model, expireTime }` or `null` (non-fatal; falls back to `fileRef`).
- Registry bypass: if `findCacheRef()` returns a hit, creation is skipped.

### Step 3 — Page Splitting (`page-splitter.ts`)

- Loads PDF with `pdf-lib`.
- Applies optional `pageRange` and `maxPages` filters.
- Slices into groups of `groupSize` pages (default: 15).
- Each `PageGroup` contains a sub-PDF buffer and the absolute page range (`{ start, end }`, 1-based).

### Step 4 — Chunk Determination (`chunk-determiner.ts`)

- Sends each page group to Gemini with:
  - **Global context**: full PDF via cache (`cachedContent`) or `fileUri`
  - **Local focus**: the group buffer as `inlineData`
- Prompt instructs: semantic boundaries, no mid-topic splits, max `maxChunkChars` per chunk, local page numbering (1..groupSize).
- Response parsed with Zod: `{ chunks: [{ pages, text, contentHint }] }`.
- Post-processing: `splitIfOversized()` splits any chunk still exceeding `maxChunkChars` at paragraph boundaries.
- Page number normalization: detects local vs. global page numbers and converts to absolute.

**contentHint values:** `table | narrative | qa | mixed`

### Step 5 — Context Summary (`summarizer.ts`)

Two modes:

**per-chunk (default):** one API call per chunk.
```
prompt: chunk.text + CONTEXT_SYSTEM_PROMPT
response: { "contextSummary": "..." }
```

**batch:** N chunks per API call.
```
prompt: [CHUNK 1]\n...\n[CHUNK N] + batch prompt
response: { "summaries": ["...", "..."] }
```

Low-quality OCR detection (`isLowQualityText`):
- Skip if text < 80 chars.
- Skip if meaningful character ratio < 45% (diagram/figure OCR noise).

### Step 6 — Embedding (`embedding/`)

Optional. Invoked if `embeddingProvider` is set in config.

Input to embedder: `"${contextSummary}\n\n${chunk.text}"`

Providers:
- `createGeminiEmbeddingProvider` — `gemini-embedding-001`, 1536 dims, `RETRIEVAL_DOCUMENT` task type
- `createOpenAiEmbeddingProvider` — `text-embedding-3-small` (default), configurable model/dims
- `createNullEmbeddingProvider` — no-op, returns empty arrays (for testing)

---

## Concurrency Model (`pool.ts`)

`processWithPool(items, concurrency, delayMs, fn, signal?)` — sliding window pool:

1. Iterates items sequentially.
2. Waits `delayMs` before dispatching each item (rate limit guard).
3. Keeps at most `concurrency` in-flight promises.
4. When the pool is full, waits for the fastest to complete (`Promise.race`).
5. Respects `AbortSignal` — stops dispatching new items; in-flight items complete.

Two separate pools:
- **Group pool**: `maxConcurrentGroups` (default: 3), `perGroupDelayMs` (default: 300ms)
- **Chunk pool**: `maxConcurrentChunks` (default: 3), `perChunkDelayMs` (default: 500ms)

---

## Retry Logic (`llm-caller.ts`)

`callWithRetry(fn, maxAttempts=5)`:
- Retries on **any** error (network, parse, 429, 500, 503, 504, unknown).
- Does **not** retry on HTTP 400, 401, 403 (non-retryable).
- Exponential backoff: `min(2^attempt × 1000ms, 30_000ms)`.

`extractJson(raw)`:
1. Strips markdown code fences.
2. Returns as-is if starts with `{`.
3. Falls back to finding first `{...}` block in the response.

---

## Cache Registry (`registry.ts`)

Local JSON file at `~/.rag-chunker/registry.json` (default).

**Schema:**
```json
{
  "files":  { "<sha256_24>": { "name", "uri", "mimeType", "expiresAt" } },
  "caches": { "<sha256_24>:<model>": { "name", "model", "expireTime" } }
}
```

**PDF identity:** SHA-256 of buffer content, first 24 hex chars.

**Expiry:**
- Files: `now + 47h` (conservative; Gemini guarantees 48h)
- Caches: API-returned `expireTime`
- 2-minute early expiry buffer (`bufferMs = 120_000`) to prevent race conditions

**Lifecycle:**
1. `loadRegistry()` — loads and prunes all expired entries on every `chunk()` call.
2. `findFileRef()` / `findCacheRef()` — returns `null` if not found or expired.
3. `setFileRef()` / `setCacheRef()` — writes new entry after successful upload/cache creation.
4. `saveRegistry()` — persists to disk after every write.

---

## Data Types

```typescript
interface FileRef {
  name: string      // "files/abc123"
  uri: string       // Gemini API URL
  mimeType: string  // "application/pdf"
}

interface CacheRef {
  name: string        // "cachedContents/abc123"
  model: string       // "models/gemini-2.0-flash"
  expireTime: string  // ISO 8601
}

interface PageGroup {
  pageRange: { start: number; end: number }  // 1-based, inclusive
  buffer: Uint8Array                          // pdf-lib sub-PDF buffer
}

interface RawChunk {
  pages: number[]
  text: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  groupIndex: number
}

interface ChunkResult {
  chunkIndex: number
  pageRange: { start: number; end: number }
  text: string
  contextSummary: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
  embedding?: number[]
  status: 'success' | 'partial' | 'error' | 'timeout'
  failedSteps?: Array<'context' | 'embedding'>
}

interface ChunkerResult {
  chunks: ChunkResult[]
  cacheUsed: boolean
  totalPages: number
  durationMs: number
}
```

---

## ChunkerConfig Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `geminiApiKey` | `string` | required | Gemini API key |
| `geminiModel` | `string` | `'gemini-1.5-pro'` | Default model for both stages |
| `chunkModel` | `string` | `geminiModel` | Model for chunk determination (Step 4) |
| `contextModel` | `string` | `geminiModel` | Model for context summary (Step 5) |
| `groupSize` | `number` | `15` | Pages per group |
| `pageRange` | `{ start, end }` | — | Process only this page range (1-based) |
| `maxPages` | `number` | — | Cap total pages processed |
| `maxConcurrentGroups` | `number` | `3` | Parallel group API calls |
| `maxConcurrentChunks` | `number` | `3` | Parallel chunk API calls |
| `perGroupDelayMs` | `number` | `300` | Delay between group dispatches (ms) |
| `perChunkDelayMs` | `number` | `500` | Delay between chunk dispatches (ms) |
| `maxChunkChars` | `number` | `3000` | Max characters per chunk (~750 tokens) |
| `skipContext` | `boolean` | `false` | Skip context summary step entirely |
| `contextMode` | `'per-chunk' \| 'batch'` | `'per-chunk'` | Context generation strategy |
| `contextBatchSize` | `number` | `10` | Chunks per batch call (batch mode only) |
| `cacheRegistry` | `string \| false` | `~/.rag-chunker/registry.json` | Registry path or `false` to disable |
| `timeoutMs` | `number` | — | Global timeout via `AbortSignal.timeout` |
| `abortSignal` | `AbortSignal` | — | External cancellation signal |
| `embeddingProvider` | `IEmbeddingProvider` | — | Optional embedding provider |
| `logger` | `ILogger` | pino to stdout | Custom logger |

---

## ChunkResult Status Values

| Status | Meaning |
|--------|---------|
| `success` | All steps completed successfully |
| `partial` | One or more steps failed (see `failedSteps`) |
| `error` | Entire group failed during chunk determination |
| `timeout` | Chunk was queued but pipeline timed out before processing |

---

## API Call Count by Mode

| Mode | Calls (100 chunks, groupSize=15, 7 groups) |
|------|---------------------------------------------|
| per-chunk | 7 groups + 100 context = **107 calls** |
| batch (size=10) | 7 groups + 10 batches = **17 calls** |
| skipContext | 7 groups = **7 calls** |
| Pro chunk + Flash context (batch) | 7 (Pro) + 10 (Flash) = **17 calls** |

Context cache reduces token cost per call but does not reduce call count.

---

## Known Limitations

- Gemini context cache requires minimum 32,768 input tokens; small PDFs fall back to `fileRef` only (non-fatal).
- Gemini occasionally returns global page numbers instead of local; normalization logic in `chunk-determiner.ts` handles this.
- Batch context mode may under-produce summaries if the model truncates its JSON for very large batches; reduce `contextBatchSize` if this occurs.
- `peerDependency` on `@google/genai ^1.44.0` is required; `openai ^4.0.0` is optional (only needed for the OpenAI embedding provider).
