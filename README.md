# @msbayindir/rag-chunker

[![npm version](https://img.shields.io/npm/v/@msbayindir/rag-chunker)](https://www.npmjs.com/package/@msbayindir/rag-chunker)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**PDF → Mistral OCR → Deterministic AST Chunker → Contextual RAG**

A production-ready pipeline that turns PDFs into retrieval-optimized chunks. Uses Mistral OCR for accurate text extraction, a deterministic AST-based chunker that respects document structure, and optionally enriches each chunk with a context summary following [Anthropic's Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) method — reducing retrieval failures by up to 49%.

---

## Highlights

- **Mistral OCR 3** as primary OCR provider; Gemini Vision as automatic fallback
- **Deterministic AST chunker** powered by remark/mdast — no LLM required for chunking, fast and reproducible
- **Anthropic Contextual Retrieval** — optional batch or per-chunk context enrichment via Gemini
- **Heading normalization** — two-phase Gemini pipeline fixes inconsistent heading levels from OCR
- **Large PDF auto-split** — PDFs over 50 MB are automatically split into 40 MB batches and merged seamlessly
- **OCR cache** — results cached locally (7-day TTL) so the same PDF is never re-processed
- **CLI + programmatic API** — use as a command-line tool or import into your own pipeline

---

## Installation

```bash
npm install @msbayindir/rag-chunker
```

`@google/genai` is a required peer dependency and is installed automatically. If you plan to use OpenAI embeddings:

```bash
npm install openai
```

---

## API Keys — Free to Get Started

You can process hundreds of documents without spending a cent.

### Mistral AI — Primary OCR

1. Go to [console.mistral.ai](https://console.mistral.ai) → Sign Up → **API Keys**
2. New accounts receive **$5 free credit** (no credit card required on sign-up)
3. Mistral OCR pricing: ~$1 per 1,000 pages → $5 gets you ~5,000 pages
4. More than enough to evaluate and prototype

> If you only have a Mistral key, OCR works. Context enrichment and heading normalization require a Gemini key.

### Google Gemini — Context Enrichment, Heading Normalization, Fallback OCR

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API Key**
2. **Completely free** on the Google AI Studio free tier — no credit card required
3. Free tier limits:
   - `gemini-2.0-flash` (context default): **1,500 requests/day**
   - `gemini-2.5-flash` (context alternative): **500 requests/day**
   - `gemini-2.5-pro` (heading normalization phase 1): **50 requests/day**

> For most documents, context enrichment uses ~20–30 batch requests. You can process 50+ documents per day on the free tier.

---

## Quick Start

```bash
# Basic — OCR + chunk, no context enrichment
npx rag-chunker process document.pdf -m YOUR_MISTRAL_KEY -o ./output

# With Anthropic-style context enrichment (recommended for RAG)
npx rag-chunker process document.pdf \
  -m YOUR_MISTRAL_KEY \
  -k YOUR_GEMINI_KEY \
  --context-mode batch \
  -o ./output

# With heading normalization (useful when OCR produces inconsistent heading levels)
npx rag-chunker process document.pdf \
  -m YOUR_MISTRAL_KEY \
  -k YOUR_GEMINI_KEY \
  --heading-normalization \
  -o ./output

# Using environment variables (recommended)
export MISTRAL_API_KEY=your_key
export GEMINI_API_KEY=your_key
npx rag-chunker process document.pdf -o ./output
```

After processing, `./output/` will contain:

```
output/
  chunks.jsonl      ← one chunk per line, ready for embedding
  document.md       ← full markdown with page markers
  structure.json    ← headings, tables, page count
  manifest.json     ← processing stats and metadata
```

---

## CLI Reference

### `rag-chunker process <pdf>`

Full pipeline: OCR → chunk → optional context enrichment → save.

```bash
rag-chunker process <pdf> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | — | Output directory. If omitted, results are not saved to disk. |
| `-m, --mistral-api-key <key>` | `MISTRAL_API_KEY` env | Mistral API key — primary OCR provider |
| `-k, --gemini-api-key <key>` | `GEMINI_API_KEY` env | Gemini API key — context enrichment, heading fix, fallback OCR |
| `--context-mode <mode>` | `none` | `none` \| `batch` \| `per-chunk` |
| `--context-model <model>` | `gemini-2.0-flash` | Gemini model for context summaries |
| `--context-batch-size <n>` | `10` | Chunks per batch in batch mode |
| `--max-chunk-tokens <n>` | `512` | Max tokens per chunk |
| `--min-chunk-tokens <n>` | `50` | Min tokens for a chunk to be emitted |
| `--overlap-tokens <n>` | `0` | Tokens prepended from the previous chunk |
| `--no-preserve-tables` | — | Do not keep tables in their own chunk |
| `--no-preserve-code` | — | Do not keep code blocks in their own chunk |
| `--heading-normalization` | — | Fix inconsistent heading levels (requires `--gemini-api-key`) |
| `--ocr-cache-path <path>` | `~/.rag-chunker/ocr-cache.json` | Custom OCR cache file path |
| `--ocr-cache-ttl <days>` | `7` | OCR cache TTL in days |
| `--no-ocr-cache` | — | Disable OCR caching |
| `--warn-large-chunk <n>` | `2000` | Warn when a table/code chunk exceeds N tokens |
| `--verbose` | — | Show verbose pipeline logs |

**Large PDF handling:** PDFs over 50 MB automatically trigger a confirmation prompt. If confirmed, the file is split into 40 MB batches, each batch is OCR'd sequentially, and results are merged — page numbers and heading hierarchy are preserved across the split.

---

### `rag-chunker ocr <pdf>`

Debug command. Runs OCR and prints each page's markdown to stdout.

```bash
rag-chunker ocr document.pdf -m YOUR_MISTRAL_KEY
```

| Option | Description |
|--------|-------------|
| `-m, --mistral-api-key <key>` | Mistral API key |
| `-k, --gemini-api-key <key>` | Gemini API key (for Vision fallback) |

---

### `rag-chunker chunk <md>`

Debug command. Runs the AST chunker on a `.md` file and prints chunk boundaries. No API key needed.

```bash
rag-chunker chunk document.md --max-tokens 512
```

| Option | Default | Description |
|--------|---------|-------------|
| `--max-tokens <n>` | `512` | Max tokens per chunk |
| `--min-tokens <n>` | `50` | Min tokens per chunk |
| `--overlap-tokens <n>` | `0` | Overlap tokens from previous chunk |
| `--no-preserve-tables` | — | Do not isolate tables |
| `--no-preserve-code` | — | Do not isolate code blocks |

---

### `rag-chunker inspect <output-dir>`

Reads an output directory and prints a summary of its manifest and structure.

```bash
rag-chunker inspect ./output
```

---

### `rag-chunker cache list / clear`

Manage the local OCR cache.

```bash
rag-chunker cache list
rag-chunker cache clear --expired    # remove entries older than TTL
rag-chunker cache clear --all        # wipe entire cache
```

| Option | Description |
|--------|-------------|
| `--cache-path <path>` | Custom cache file path |
| `--ttl <days>` | TTL for expired check (default: 7) |

---

## Programmatic API

### `process(pdfInput, config)`

Full pipeline. Returns a `ProcessResult` with chunks, markdown, structure, manifest, and a `save()` method.

```typescript
import { process } from '@msbayindir/rag-chunker'

const result = await process('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  contextMode: 'batch',
  maxChunkTokens: 512,
})

// Save all output files
await result.save('./output')

// Or work with chunks directly
for (const chunk of result.chunks) {
  console.log(chunk.content)     // embed this
  console.log(chunk.sectionPath) // breadcrumb path
  console.log(chunk.pageNumber)
}
```

### `chunk(pdfInput, config)`

Convenience wrapper. Forces `contextMode: 'none'` and returns only `Chunk[]`.

```typescript
import { chunk } from '@msbayindir/rag-chunker'

const chunks = await chunk('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  maxChunkTokens: 512,
})
```

### Full `ChunkerConfig` Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mistralApiKey` | `string` | — | Mistral API key — primary OCR |
| `geminiApiKey` | `string` | — | Gemini API key — context, heading fix, fallback OCR |
| `contextMode` | `'none' \| 'batch' \| 'per-chunk'` | `'none'` | Context enrichment mode |
| `contextModel` | `string` | `'gemini-2.0-flash'` | Gemini model for context summaries |
| `contextBatchSize` | `number` | `10` | Chunks per Gemini batch call |
| `contextConcurrency` | `number` | `2` | Max concurrent calls in per-chunk mode |
| `maxChunkTokens` | `number` | `512` | Max tokens per chunk |
| `minChunkTokens` | `number` | `50` | Min tokens per chunk |
| `overlapTokens` | `number` | `0` | Overlap tokens prepended from previous chunk |
| `preserveTables` | `boolean` | `true` | Keep tables in their own chunk |
| `preserveCodeBlocks` | `boolean` | `true` | Keep code blocks in their own chunk |
| `ocrCachePath` | `string \| false` | `~/.rag-chunker/ocr-cache.json` | Cache path. `false` to disable. |
| `ocrCacheTtlDays` | `number` | `7` | OCR cache TTL in days |
| `headingNormalization` | `boolean` | `false` | Fix OCR heading levels via Gemini |
| `headingFixPhase1Model` | `string` | `'gemini-2.5-pro'` | Model for structure discovery phase |
| `headingFixPhase2Model` | `string` | `'gemini-2.5-flash-preview-05-20'` | Model for correction phase |
| `warnLargeChunkTokens` | `number` | `2000` | Warn threshold for oversized preserved chunks |
| `embeddingProvider` | `IEmbeddingProvider` | — | Embedding provider (optional) |
| `logger` | `ILogger` | pino at INFO | Custom logger |

---

## Embedding Providers

Built-in providers can optionally generate embeddings inline during the pipeline.

```typescript
import {
  createGeminiEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createNullEmbeddingProvider,
} from '@msbayindir/rag-chunker'

// Gemini — 1536 dimensions
const geminiProvider = createGeminiEmbeddingProvider({
  apiKey: process.env.GEMINI_API_KEY!,
})

// OpenAI text-embedding-3-large — 3072 dimensions (requires: npm install openai)
const openaiProvider = createOpenAiEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
})

// Null — returns empty vectors, useful for testing
const nullProvider = createNullEmbeddingProvider()

const result = await process('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  embeddingProvider: openaiProvider,
})
// result.chunks[0].embedding → number[]
```

> **Note:** Embedding is non-fatal. If the provider throws, the chunk is still returned with `embedding: []`.

---

## Output Files

### `chunks.jsonl`

One JSON object per line. Each line is a `Chunk`:

```jsonc
{
  "chunkId": "a3f7c2d1...",        // SHA-256(rawContent), first 32 hex chars — deterministic
  "index": 0,                       // 0-based position in chunk array
  "content": "Context: This section covers sodium metabolism in the electrolyte chapter.\n\n## Sodium Metabolism\n\nSodium is...",
  "rawContent": "## Sodium Metabolism\n\nSodium is...",   // pure markdown, no context
  "contextSummary": "This section covers sodium metabolism in the electrolyte chapter.",
  "tokenCount": 412,
  "contentType": "text",            // "text" | "table" | "code" | "mixed"
  "sectionPath": ["Electrolyte Disorders", "Sodium Metabolism"],
  "pageNumber": 14,                 // 1-based, from OCR page markers
  "prevChunkId": "9f1a...",
  "nextChunkId": "c82b...",
  "mustPreserve": false,            // true for table/code chunks that can't be split
  "embedding": []                   // number[] if embeddingProvider was configured
}
```

### `document.md`

Full document markdown with page markers:

```markdown
<!-- page 1 -->

# Chapter 1

Content...

<!-- page 2 -->

## Section 1.1
```

### `structure.json`

Document structure extracted from markdown:

```jsonc
{
  "headings": [
    { "level": 1, "text": "Chapter 1", "pageNumber": 1, "markdownLine": 3 }
  ],
  "tables": [
    { "index": 0, "caption": "Table 1. Electrolyte values", "pageNumber": 5, "rowCount": 8, "columnCount": 3 }
  ],
  "tableCount": 12,
  "codeBlockCount": 0,
  "pageCount": 192,
  "totalTokens": 68432
}
```

### `manifest.json`

Processing metadata:

```jsonc
{
  "version": "3.0",
  "processedAt": "2026-03-16T00:20:51.118Z",
  "pdfHash": "0f2860b4...",
  "ocrModel": "mistral-ocr-latest",
  "contextModel": "gemini-2.0-flash",
  "contextMode": "batch",
  "chunkStats": {
    "total": 183, "avgTokens": 378,
    "minTokens": 50, "maxTokens": 2662,
    "tableChunks": 25, "codeChunks": 0, "textChunks": 158, "mixedChunks": 0
  },
  "durationMs": 146689,
  "ocrCacheHit": true,
  "headingFix": null,               // populated if --heading-normalization was used
  "contextEnrichment": {
    "model": "gemini-2.0-flash",
    "chunksEnriched": 176,
    "chunksSkipped": 7,             // low-quality OCR artifacts skipped
    "batchCalls": 19,
    "durationMs": 146005,
    "cacheUsed": true               // whether Gemini CachedContent was used
  }
}
```

---

## Contextual Retrieval — What to Embed and Why

### The Problem with Naive Chunking

When you split a document into chunks and embed them independently, each chunk loses its context. A chunk containing `"It was founded in 1987 and has since expanded to 42 countries"` provides no signal for a query about a specific organization — the surrounding context that identifies the subject is gone.

This is the core retrieval failure in most RAG systems.

### Anthropic's Solution — and the Numbers

In September 2024, Anthropic published [**Contextual Retrieval**](https://www.anthropic.com/news/contextual-retrieval), showing that prepending a short, situating summary to each chunk before embedding significantly improves retrieval:

| Method | Retrieval Failure Reduction |
|--------|-----------------------------|
| Basic semantic embedding | baseline |
| Contextual embedding | **49% fewer failures** |
| Contextual embedding + BM25 hybrid | **67% fewer failures** |

The approach: for each chunk, generate a 1–2 sentence summary that situates it within the document — what section it belongs to, what topic it covers. Prepend this to the chunk content before embedding.

### How This Package Implements It

When `--context-mode batch` (or `per-chunk`) is used:

1. The full document markdown is sent to Gemini as context
2. For each chunk, a 1–2 sentence summary is generated in the **same language as the document**
3. The `contextSummary` field is stored separately
4. `content` is assembled as: `"Context: <summary>\n\n<rawContent>"`

This matches Anthropic's exact format.

### Which Field Should You Embed?

| Your setup | Embed this field |
|-----------|-----------------|
| `--context-mode batch` or `per-chunk` (recommended) | **`content`** — includes the context summary |
| `--context-mode none` (default) | `content` or `rawContent` — they are identical |
| Hybrid search: vector + BM25/keyword | `content` for vector index, `rawContent` for keyword index |

```typescript
// Reading chunks.jsonl and embedding
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

const rl = createInterface({ input: createReadStream('./output/chunks.jsonl') })
for await (const line of rl) {
  const chunk = JSON.parse(line)
  const textToEmbed = chunk.content  // always use content
  // → send to your vector database
}
```

### Should You Strip Markdown Before Embedding?

Modern embedding models (OpenAI `text-embedding-3-large`, Gemini `embedding-001`, Cohere `embed-v3`) are trained on web-scale data that includes markdown. They handle `#`, `**`, `|` and similar syntax gracefully — stripping is generally not necessary.

Research findings:
- **Nussbaum et al. (2024)** — *Nomic Embed: Training a Reproducible Long Context Text Embedder* — shows retrieval quality is robust to markdown formatting in general-purpose embedders
- **Muennighoff et al. (2022)** — *MTEB: Massive Text Embedding Benchmark* — the benchmark includes mixed-format text; top models perform well without preprocessing
- For **table-heavy content**, stripping `|` separators can marginally improve semantic similarity scores; for prose, the effect is negligible

**This package does not strip markdown.** If your downstream embedding model or use case requires clean text, strip it yourself before embedding — this is intentionally left to the caller:

```typescript
// Optional: strip markdown before embedding (your responsibility)
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')          // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold
    .replace(/_([^_]+)_/g, '$1')        // italic
    .replace(/`([^`]+)`/g, '$1')        // inline code
    .replace(/\|/g, ' ')                // table separators
    .replace(/\s+/g, ' ').trim()
}

const textToEmbed = stripMarkdown(chunk.content)
```

---

## Advanced Usage

### Custom Logger

Replace the default pino logger with your own:

```typescript
import { process } from '@msbayindir/rag-chunker'

const result = await process('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  logger: {
    debug: (msg, meta) => console.debug('[rag]', msg, meta),
    info:  (msg, meta) => console.info('[rag]', msg, meta),
    warn:  (msg, meta) => console.warn('[rag]', msg, meta),
    error: (msg, meta) => console.error('[rag]', msg, meta),
  }
})
```

### Disable or Customize OCR Cache

```typescript
// Disable caching entirely
const result = await process('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  ocrCachePath: false,
})

// Use a project-local cache instead of ~/.rag-chunker/
const result = await process('document.pdf', {
  mistralApiKey: process.env.MISTRAL_API_KEY,
  ocrCachePath: './.rag-cache/ocr.json',
  ocrCacheTtlDays: 30,
})
```

### Heading Normalization

OCR pipelines often produce inconsistent heading levels — a section title becomes `# Title` on one page and `## Title` on another, or numbered sections (`1.1`, `1.2`) get assigned the wrong level.

The two-phase normalization process:
1. **Phase 1 (Gemini Pro):** Sends the full document to discover structure — document type, main sections, numbering patterns
2. **Phase 2 (Gemini Flash):** Sends the discovered structure + heading list (not the full document) and corrects each heading's level

Enable it when:
- The source PDF has complex, multi-level structure (textbooks, technical reports)
- OCR produces mismatched heading levels
- You need accurate `sectionPath` breadcrumbs in your chunks

```bash
rag-chunker process document.pdf \
  -m YOUR_MISTRAL_KEY \
  -k YOUR_GEMINI_KEY \
  --heading-normalization \
  -o ./output
```

> Phase 1 uses `gemini-2.5-pro` (50 requests/day on free tier). For a 200-page document, this is 1 request. You can process up to 50 documents per day with heading normalization on the free tier.

### Process a Buffer Instead of a File Path

```typescript
import { readFileSync } from 'fs'
import { process } from '@msbayindir/rag-chunker'

const pdfBuffer = readFileSync('document.pdf')
const result = await process(pdfBuffer, {
  mistralApiKey: process.env.MISTRAL_API_KEY,
})
```

---

## Cost Reference

| Setup | Approx. cost per 200-page document |
|-------|-------------------------------------|
| OCR only (Mistral) | ~$0.05 |
| OCR + context enrichment (batch) | ~$0.15–0.22 |
| OCR + heading normalization | ~$0.06 |
| OCR + context + heading normalization | ~$0.23 |
| v2 equivalent (LLM-based OCR + chunking) | ~$0.95 |

---

## Requirements

- Node.js ≥ 20
- At least one of: `MISTRAL_API_KEY` or `GEMINI_API_KEY`

---

## License

MIT
