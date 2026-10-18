# rag-chunker

[![npm](https://img.shields.io/npm/v/@msbayindir/rag-chunker)](https://www.npmjs.com/package/@msbayindir/rag-chunker)
[![CI](https://github.com/msbayindir/rag-chunker/actions/workflows/ci.yml/badge.svg)](https://github.com/msbayindir/rag-chunker/actions/workflows/ci.yml)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

**PDF, Word, PowerPoint, images and Markdown → retrieval-ready chunks.**
One `npx` command, no Python. Runs with **no API keys**, **fully local** on Ollama (Gemma 4), or with any cloud model — Gemini, Claude, OpenAI, OpenRouter, Mistral OCR — and you can mix them per stage.

[Türkçe README](README.tr.md)

```bash
npx @msbayindir/rag-chunker process book.pdf            # no keys: text layer + structure-aware chunks
npx @msbayindir/rag-chunker process book.pdf --local    # everything on Ollama, nothing leaves your machine
```

## Why rag-chunker

- **Chunks that respect the document.** A deterministic, AST-based chunker keeps headings with their content, never splits mid-sentence unless it must, splits big tables by rows *with the header repeated*, keeps code fences intact and never drops a word (property-tested).
- **Accurate citations.** Every chunk has `pageStart`/`pageEnd`, a heading breadcrumb (`sectionPath`) and a stable, collision-free `chunkId`.
- **Tiered OCR.** Digital pages are read from the PDF text layer for free; only scanned pages go to Mistral OCR or a vision model (Gemma 4, Gemini, Claude, GPT…). Running headers, footers and page numbers are removed.
- **Contextual retrieval** ([Anthropic's method](https://www.anthropic.com/news/contextual-retrieval)): each chunk gets a 1–2 sentence summary that situates it in the document. Large documents that do not fit a model use document + section summaries instead, so it works with small local models too.
- **Heading repair.** OCR reads pages one by one and gets heading levels wrong; an LLM pass plus a deterministic numbering pass fixes them.
- **Any provider, per stage.** `provider/model` everywhere: `ollama/gemma4:e4b-it-qat`, `gemini/gemini-3.5-flash-lite`, `anthropic/claude-haiku-5-5`, `openrouter/…`, or your own OpenAI-compatible server. Native prompt caching for each provider.
- **Resumable and cheap to re-run.** OCR pages, summaries and embeddings are cached; an interrupted run continues where it stopped, and changing chunk sizes never re-pays for OCR.
- **Measurable quality.** `rag-chunker eval` generates evidence-grounded questions and reports hit@k / MRR for BM25, vector and hybrid search — compare chunking settings side by side.
- **Batteries included.** Browser inspector, exports to pgvector / Qdrant / LanceDB, and an MCP server so agents (Claude Desktop, Claude Code…) can search your documents.

## Quick start

```bash
# 1. Check what is available on this machine
npx @msbayindir/rag-chunker doctor

# 2. (optional) Create a config with a guided setup — detects Ollama, RAM and API keys
npx @msbayindir/rag-chunker init

# 3. Process documents (files or whole folders)
npx @msbayindir/rag-chunker process docs/ -o out/

# 4. Look at the result
npx @msbayindir/rag-chunker inspect out/report --ui --pdf docs/report.pdf
```

### Fully local (private documents)

```bash
brew install ollama            # or https://ollama.com/download
ollama pull gemma4:e4b-it-qat  # vision + text, ~6 GB; 16 GB RAM is enough
ollama pull embeddinggemma     # embeddings, ~0.6 GB
npx @msbayindir/rag-chunker process contract.pdf --local
```

`--local` picks the best installed Gemma 4 for your RAM and turns on every stage: vision OCR for scanned pages, heading repair, contextual summaries and embeddings. Even if `MISTRAL_API_KEY` is set, nothing is sent to the cloud.

### Cloud models

API keys are read from the environment or a `.env` file in the current folder — never from config files.

```bash
echo "GEMINI_API_KEY=..." >> .env
npx @msbayindir/rag-chunker process book.pdf \
  --context gemini/gemini-3.5-flash-lite \
  --embedding gemini/gemini-embedding-001
```

With `MISTRAL_API_KEY` set, PDFs are OCR'd by Mistral OCR automatically (best quality for tables and complex layouts). If the key's plan has no OCR quota, rag-chunker warns and continues with the next engine.

## How it works

```
read ─▶ OCR ─▶ headings ─▶ chunk ─▶ context ─▶ embed ─▶ chunks.jsonl, document.md, structure.json, document.json, manifest.json
        │       (optional)            (optional)  (optional)
        ├─ text layer (digital pages, free)
        ├─ Mistral OCR (all pages)          ← when MISTRAL_API_KEY is set
        └─ vision model (scanned pages)     ← models.vision / --local
```

A stage without a model is skipped. With no configuration you get the text layer and the chunker — no network calls at all.

| Input | How it is read |
|---|---|
| PDF | Text layer (headings from font sizes, lists, two-column order, de-hyphenation); scanned pages through the OCR engine |
| DOCX | Word headings, paragraphs and tables (mammoth → GFM) |
| PPTX | One page per slide: title, nested bullets, tables, speaker notes |
| PNG / JPEG / WebP | OCR engine (Mistral or a vision model) |
| Markdown / text | As is; `<!-- page N -->` markers set page numbers |

## Choosing models

Every model is written as `provider/model`. Built-in providers need no configuration:

| Provider | Key (environment) | Example models |
|---|---|---|
| `ollama` | — (`OLLAMA_HOST`, default `127.0.0.1:11434`) | `gemma4:e4b-it-qat`, `gemma4:12b-it-qat`, `embeddinggemma` |
| `gemini` | `GEMINI_API_KEY` | `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-embedding-001` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-5-5`, `claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | your chat model, `text-embedding-3-large` |
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5-5`, any OpenRouter id |
| `mistral` | `MISTRAL_API_KEY` | OCR (`ocr.engine: "mistral"`), `mistral-embed` |
| `lmstudio` | — | whatever LM Studio serves on port 1234 |

Model ids change over time; use the ones your account offers. `rag-chunker doctor` checks every configured model.

Any OpenAI-compatible server (vLLM, llama.cpp, a gateway…) works by naming it:

```json
{
  "providers": { "lab": { "type": "openai-compatible", "baseURL": "http://localhost:8000/v1", "apiKeyEnv": "LAB_KEY" } },
  "models": { "context": "lab/qwen3-32b" }
}
```

**Suggested combinations**

| Goal | vision / OCR | context | embedding |
|---|---|---|---|
| Free and private | `ollama/gemma4:e4b-it-qat` | same | `ollama/embeddinggemma` |
| Best PDFs, cheap | Mistral OCR | `gemini/gemini-3.5-flash-lite` | `gemini/gemini-embedding-001` |
| Mixed | Mistral OCR | `ollama/gemma4:12b-it-qat` | `openai/text-embedding-3-large` |
| One key | `openrouter/…` | `openrouter/anthropic/claude-haiku-5-5` | in your vector DB |

## Configuration

Settings come from (highest priority first): **CLI flags → `rag-chunker.config.json` (or `.mjs`/`.js`) → automatic detection → defaults.**

```json
{
  "$schema": "./node_modules/@msbayindir/rag-chunker/schema/config.schema.json",
  "ocr": { "engine": "auto" },
  "models": {
    "vision": "ollama/gemma4:e4b-it-qat",
    "structure": "anthropic/claude-sonnet-5-5",
    "context": "ollama/gemma4:e4b-it-qat",
    "embedding": "ollama/embeddinggemma"
  },
  "chunk": { "maxTokens": 512, "minTokens": 64, "overlapTokens": 0 }
}
```

The `$schema` line gives autocompletion and documentation in VS Code and other editors. In JavaScript use `defineConfig`:

```js
// rag-chunker.config.mjs
import { defineConfig } from '@msbayindir/rag-chunker'
export default defineConfig({ models: { context: 'gemini/gemini-3.5-flash-lite' } })
```

| Option | Default | Meaning |
|---|---|---|
| `ocr.engine` | `auto` | `auto` (Mistral if `MISTRAL_API_KEY`, else `models.vision`, else text layer), `text-layer`, `mistral`, or a vision `provider/model` |
| `ocr.pages` | `auto` | PDF pages sent to the engine: `all`, `scanned` (`auto`: all for Mistral, scanned for vision models) |
| `ocr.removeHeaderFooter` | `true` | Drop running headers, footers and page numbers |
| `ocr.stripImages` | `true` | Drop image placeholders such as `![img-0.jpeg](img-0.jpeg)` |
| `ocr.minTextChars` | `40` | Pages with less extractable text count as scanned |
| `models.vision` / `structure` / `context` / `embedding` | — | Model per stage; unset = stage skipped |
| `chunk.maxTokens` | `512` | Hard limit per chunk (o200k tokens) |
| `chunk.minTokens` | `64` | Smaller chunks merge with a neighbour in the same section |
| `chunk.overlapTokens` | `0` | Trailing sentences of the previous chunk, prepended to `content` |
| `chunk.hardBoundaryDepth` | `2` | H1/H2 always start a new chunk |
| `chunk.preserveTables` / `preserveCode` | `true` | Keep tables/code in their own chunks |
| `chunk.tokenizer` | `o200k` | `o200k` (real BPE) or `estimate` (fast approximation) |
| `context.strategy` | `auto` | `full` (whole document as cached context), `hierarchical` (document + section summaries), `auto` (`full` up to 60k tokens when the model's context allows, otherwise `hierarchical`) |
| `context.batchSize` | `8` | Chunks per request |
| `embedding.dimensions` | — | Output size for models that support it |
| `providers.<name>` | — | `type`, `baseURL`, `apiKeyEnv`, `headers`, `contextWindow`, `maxContext` (Ollama `num_ctx` cap, default 32768), `concurrency`, `timeoutMs`, `maxRetries` |
| `cache.enabled` / `cache.dir` | `true` / `~/.rag-chunker/cache` | On-disk cache |

## CLI

| Command | What it does |
|---|---|
| `process <files/folders…>` | Run the pipeline. `-o <dir>`, `--local`, `--ocr`, `--vision`, `--structure`, `--context`, `--embedding`, `--max-tokens`, `--min-tokens`, `--overlap`, `--context-strategy`, `--no-cache`, `--dry-run`, `--json`, `--verbose` |
| `init` | Guided setup; offers to download Gemma 4 / EmbeddingGemma; `--yes` for defaults |
| `doctor` | Checks Node, cache, keys, Ollama and every configured model (metadata only, no paid calls) |
| `inspect <dir>` | Summary; `--ui` opens a local browser UI with search and `--pdf` page view |
| `eval <dirs…>` | Retrieval benchmark (`--model`, `--questions`, `--questions-file`, `--embedding`) |
| `export <dirs…> --to pgvector\|qdrant\|lancedb` | Upsert chunks and vectors (`--url`, `--table`, `--replace-document`, `--embedding`, `--index`) |
| `mcp <dirs…>` | MCP server over stdio for AI agents |
| `cache info` / `cache clear [--older-than <days>]` | Manage the cache |

`--dry-run` shows pages to OCR, the estimated number of chunks and requests and an upper bound for context tokens, without calling any model.

## Output

`process` writes five files per document:

| File | Content |
|---|---|
| `chunks.jsonl` | One chunk per line (below) |
| `document.md` | Full markdown with `<!-- page N -->` markers |
| `structure.json` | Headings, tables, sections, page count |
| `document.json` | Every block (heading, paragraph, list, table, code) with its page, position on the page and the chunks that contain it |
| `manifest.json` | Version, models per stage, page/chunk statistics, token usage, the config used (without keys), warnings |

```jsonc
{
  "chunkId": "332e7af07d0e-d5c8ae6169f9fdc6", // document prefix + content hash: stable across runs
  "documentId": "332e7af07d0e…",              // sha256 of the file
  "source": "turkish.pdf",
  "index": 0,
  "content": "Context: Bu bölüm …\n\n## 1. Hiponatremi\n\n…", // embed this
  "rawContent": "## 1. Hiponatremi\n\n…",                       // verbatim markdown
  "contextSummary": "Bu bölüm …",
  "tokenCount": 304,
  "contentType": "text",                       // text | table | code | mixed
  "sectionPath": ["Elektrolit Bozuklukları", "1. Hiponatremi"],
  "pageStart": 1,
  "pageEnd": 2,
  "ocrSource": "text-layer",                   // or mistral, ollama/gemma4:…, docx, pptx, markdown
  "boxes": [{ "page": 1, "x": 0.12, "y": 0.31, "w": 0.76, "h": 0.05 }], // where the text sits (fractions of the page, origin top-left); [] when unknown
  "prevChunkId": null,
  "nextChunkId": "332e7af07d0e-f3bd60c543caae4e",
  "mustPreserve": false,
  "embedding": [0.0123, …]                     // [] when no embedding model is set
}
```

**Positions.** Chunks read from a PDF text layer carry `boxes`: one rectangle per paragraph, heading or list item, as fractions of the page size (`x`, `y`, `w`, `h`, origin top-left), so an application can highlight the source of an answer on the page at any zoom level. `document.json` has the same positions for every block plus `chunkIds`; `rag-chunker inspect --ui --pdf` draws them over the page. OCR'd pages, DOCX, PPTX and Markdown have no positions (`boxes: []`, `box: null`).

**What to embed:** `content` (it includes the context summary and overlap). For hybrid search index `content` in the vector store and `rawContent` for keyword search. Embed queries with the same model and `embedQuery()` — Gemini and EmbeddingGemma use different prompts for documents and queries.

## Programmatic API

```ts
import { processDocument } from '@msbayindir/rag-chunker'

const result = await processDocument('book.pdf', {
  models: { context: 'ollama/gemma4:e4b-it-qat', embedding: 'ollama/embeddinggemma' },
}, {
  onProgress: (e) => e.type === 'progress' && console.log(e.stage, `${e.done}/${e.total}`),
  signal: AbortSignal.timeout(30 * 60_000),
})

await result.save('out/book')
for (const chunk of result.chunks) {
  // chunk.content → vector store, chunk.sectionPath / pageStart → citations
}
```

| Function | Purpose |
|---|---|
| `processDocument(input, config?, options?)` | Full pipeline; `input` is a path or bytes (`options.name` sets `source`) |
| `planDocument(input, config?)` | Dry run: what would happen, no model calls |
| `chunkMarkdown(markdown, options?)` | Chunk a markdown string, no providers |
| `embedTexts(texts, model, options?)` / `embedQuery(query, model, options?)` | Embeddings with caching and input-length protection |
| `buildSearchIndex(chunks)` + `search(index, query, { queryVector })` | BM25, vector or hybrid (RRF) search |
| `generateQuestions(…)` / `evaluate(…)` | Retrieval evaluation |
| `exportToPgvector(client, chunks)` / `exportToQdrant(…)` / `exportToLanceDb(…)` | Vector database exports |
| `createMcpServer({ dirs })` | MCP server instance |
| `readOutputDir(dir)` | Load a saved output folder |
| `loadConfig()` / `resolveConfig()` / `defineConfig()` | Configuration helpers |

Programmatic callers may pass keys directly: `{ providers: { gemini: { apiKey: '…' } } }`. All errors are `RagChunkerError` with a stable `code` and a human-readable `hint`.

## Vector databases

```bash
# Postgres + pgvector (or DATABASE_URL)
npx @msbayindir/rag-chunker export out/book --to pgvector --url postgres://localhost/rag --replace-document --index
# Qdrant (QDRANT_URL / QDRANT_API_KEY)
npx @msbayindir/rag-chunker export out/book --to qdrant --url http://localhost:6333
# LanceDB (embedded, needs: npm install @lancedb/lancedb)
npx @msbayindir/rag-chunker export out/book --to lancedb --url ./lancedb
```

`--replace-document` removes chunks of the same document that a new run no longer produces, so re-processing never leaves stale rows. Outputs without embeddings can be embedded during export with `--embedding <model>`.

## Measuring quality

```bash
npx @msbayindir/rag-chunker process book.pdf -o runs/512 --max-tokens 512 --embedding ollama/embeddinggemma
npx @msbayindir/rag-chunker process book.pdf -o runs/256 --max-tokens 256 --embedding ollama/embeddinggemma
npx @msbayindir/rag-chunker eval runs/512 runs/256 --model ollama/gemma4:e4b-it-qat --questions 40
```

Questions come with a verbatim evidence quote, so they are valid for any chunking of the same document. The table shows hit@1/5/10 and MRR for BM25, vector and hybrid search; the question set is saved and can be reused with `--questions-file`.

## MCP server for agents

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@msbayindir/rag-chunker", "mcp", "/absolute/path/to/out/book"] }
  }
}
```

Tools: `search` (hybrid when the chunks have embeddings), `get_chunk` (with neighbours), `get_page`, `list_documents`.

## Caching, cost and privacy

- Cache keys depend on content, model and prompt version — never on API keys. `rag-chunker cache info` shows the size, `cache clear --older-than 30` prunes it.
- Context requests put the document first so every provider can reuse it: explicit cache blocks for Claude, explicit caches for Gemini, prefix caching for OpenAI-compatible servers and Ollama.
- Usage (requests, input/output/cached tokens) is recorded per stage in `manifest.json`.
- With `--local` or Ollama-only models, documents never leave the machine.

## Troubleshooting

| Problem | Fix |
|---|---|
| `N page(s) have no usable text layer` | Scanned pages: set `MISTRAL_API_KEY`, use `--local`, or `--ocr <vision model>` |
| `model is not installed in Ollama` | `ollama pull <model>` |
| `cannot reach Ollama` | Start the Ollama app or `ollama serve`; set `OLLAMA_HOST` for remote hosts |
| `needs an API key` | Put the key in `.env` or the environment (the error names the variable) |
| `plan has no quota for this model` | The key works but its plan allows 0 requests for that model (common for Mistral OCR on free plans). Enable billing in the provider console. With `ocr.engine: "auto"` rag-chunker warns and falls back to the vision model or the text layer |
| `rate limited (429) even after retries` | Lower `providers.<name>.concurrency` and run again — finished pages and chunks come from the cache |
| Vision OCR needs `@napi-rs/canvas` | `npm install @napi-rs/canvas` (installed by default unless optional dependencies are skipped) |
| Small local model returns invalid JSON | It is retried and split automatically; persistent failures appear as warnings. Use a larger model for `structure` |

Run `rag-chunker doctor` first; it checks everything above.

## Requirements

Node.js 22 or newer. Optional: [Ollama](https://ollama.com) for local models.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a provider means implementing the small `LLM` / `Embedder` interfaces in `src/providers/`.

## License

[MIT](LICENSE)
