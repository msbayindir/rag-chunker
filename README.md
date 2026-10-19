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
- **Tiered OCR.** Digital pages are read from the PDF text layer for free; only scanned pages go to OCR: the local PP-OCRv5 models (13–97 MB depending on the profile, no keys, Latin scripts incl. Turkish), Mistral OCR, or a vision model (Gemma 4, Gemini, Claude, GPT…). Running headers, footers and page numbers are removed.
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

Scanned pages: `--ocr pp-ocr` runs PP-OCRv5 locally (downloads the models once: 97 MB with the default `full` profile, 13 MB with `--profile basic`; `auto` picks it from then on). With `MISTRAL_API_KEY` set and no local models, Mistral OCR is used (strong on tables and complex layouts). If an automatically chosen engine turns out unusable (no quota, download failure), rag-chunker warns and continues with the next one.

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
| XLSX | One page per visible sheet: cell blocks as GFM tables (blank rows split them, a lone cell above is a title), dates, percentages, booleans and formula results resolved, merged cells repeated |
| HTML | The main content (`<main>`, a single `<article>`, else the body) without scripts, navigation, site header/footer and hidden elements; tables of any shape, code blocks, alt texts |
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
| `cohere` | `COHERE_API_KEY` | Reranking only: `rerank.engine: "cohere/rerank-v3.5"` |
| `jina` | `JINA_API_KEY` | Reranking only: `rerank.engine: "jina/jina-reranker-v2-base-multilingual"` |
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
| `ocr.engine` | `auto` | `auto` (local PP-OCR when its models are downloaded, else Mistral if `MISTRAL_API_KEY`, else `models.vision`, else text layer), `text-layer`, `pp-ocr`, `mistral`, or a vision `provider/model` |
| `ocr.pages` | `auto` | PDF pages sent to the engine: `all`, `scanned` (`auto`: all for Mistral, scanned for vision models) |
| `ocr.detector` | `auto` | Text detector of the local OCR: `mobile` (PP-OCRv5 mobile, 5 MB, fast), `server` (PP-OCRv5 server, 84 MB; more small print and table cells, about 1.8× slower), `auto` (follows `local.profile`) |
| `ocr.script` | `auto` | Recogniser of the local OCR: `latin` (Turkish, English, German, French, …), `cjk` (PP-OCRv5 server model for Chinese, Japanese and English, 84 MB, about 10× slower per line, no Ğ/İ), `auto` (with the `full` profile the widest lines of a document's first scanned page are read with the CJK model and the document switches to it when they come back as CJK text) |
| `local.profile` | `full` | Which local models the `auto` settings pick: `full` (the strongest models, larger downloads; today the server OCR detector and the CJK recogniser for `ocr.script: auto`), `basic` (the small Latin models; CLI `--profile basic`) |
| `formulas.recognize` | `auto` | Display formulas in the layout model's formula regions are read as LaTeX with a local model ([texify2](https://huggingface.co/vikp/texify2), 8-bit ONNX, 320 MB, needs `npm install @huggingface/transformers`) and written as `$$…$$` blocks: `auto` (on with the `full` profile when layout analysis runs and the package is installed), `on`, `off` (CLI `--no-formulas`) |
| `local.device` | `auto` | Where the local models that gain from an accelerator run (the OCR text detector and the CJK recogniser; the layout, table, Latin OCR and reranker models stay on the CPU, where they are faster): `auto` (CoreML on macOS, CUDA elsewhere when `onnxruntime-node` offers them, else CPU), `cpu`, `coreml`, `cuda`. A model the accelerator cannot take falls back to the CPU; `doctor` shows the device in use |
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
| `layout.engine` | `auto` | Page layout analysis for PDFs with a local ONNX model: `auto` (on when `onnxruntime-node` and the downloaded model are present), `pp-doclayout-v3` (on; downloads the models once), `off` |
| `layout.minScore`, `layout.render` | `0.5`, `1024` | Detection confidence; longer page side in pixels rendered for the model |
| `figures.extract` | `true` | Cut the figures of PDF pages and images out as PNG files under `figures/` and reference them from the markdown (`--no-figures` turns it off) |
| `figures.describe` | `false` | Describe every figure with `models.vision` (two to five sentences stored under the image, for retrieval); one vision request per figure (`--describe-figures`) |
| `figures.minSize` | `0.015` | Smallest figure kept, as a share of the page area (icons and logos fall below it) |
| `rerank.engine` | `auto` | Reranker that reorders the top search candidates in `eval` and `mcp`: `auto` (the local model when downloaded), `mmarco-minilm` (120 MB, 14 languages + transfer), `bge-reranker-base` (280 MB), `bge-reranker-v2-m3` (570 MB, 100+ languages, slow on CPU), a hosted one as `cohere/rerank-v3.5` or `jina/jina-reranker-v2-base-multilingual`, or `off` |
| `rerank.candidates` | `30` | First-stage results (hybrid or BM25) handed to the reranker |
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

**Local OCR (no keys).** `--ocr pp-ocr` (and `--local`) reads scanned pages and images with PP-OCRv5 mobile on `onnxruntime-node`: a 5 MB text detector and an 8 MB Latin-script recogniser (Turkish, English, German, French, Spanish, Italian, Portuguese, Dutch, Polish, …; other scripts are planned). OCR lines enter the same pipeline as text-layer lines, so headings, lists, tables found by alignment, layout regions and positions all work on scanned pages; each line carries a confidence that reaches `document.json` (`confidence`), and the words of a line keep their positions (from the recogniser's time steps), so cells of a scanned table that sit side by side on one line are told apart. The detector sees the page at 960 px; when that leaves only tiny lines (dense newspaper scans), the page is detected again at the resolution that makes a line about 12 px tall, so small print is not lost. About 0.3–1 s per page on a laptop CPU, cached per page. Once the models are downloaded, `auto` prefers local OCR over Mistral. Two detectors are available: the default `full` profile uses the PP-OCRv5 server detector (84 MB; on scanned Turkish guidelines it cut the character error rate from 13.2 % to 10.1 %, on a constitution from 2.5 % to 1.5 %), `--profile basic` or `ocr.detector: "mobile"` the 5 MB mobile one, about 1.8× faster. Environment knobs until they become config options: `RAG_CHUNKER_THREADS` (ONNX threads), `RAG_CHUNKER_OCR_DET_LIMIT` (detector input size), `RAG_CHUNKER_OCR_DET_MIN_LINE` (second-pass trigger, 0 disables), `RAG_CHUNKER_OCR_DET_MODEL` (detector override for benchmarks).

**Layout analysis (local, no keys).** With `--layout` (or `--local`), every PDF page also goes through [PP-DocLayoutV3](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3), a 130 MB ONNX model that labels the blocks of the page (title, section title, text, table, figure, caption, footnote, header/footer, page number, formula, reference…) and gives their reading order. rag-chunker still takes the text from the text layer; the model decides what each block is and in which order it is read: running headers, footers, page numbers and the labels inside figures are dropped, captions and footnotes never become headings, titles do (wrapped title lines merge), tables are looked for where the model sees one, and two-column or magazine-style pages follow the model's order. Blocks in `document.json` carry the class as `label`. Needs the optional `onnxruntime-node` package (`npm install onnxruntime-node`, ~260 MB of runtime binaries); the models (PP-DocLayoutV3 + SLANet_plus, 138 MB) are downloaded from the project's Hugging Face repository ([msbayindir/rag-chunker-models](https://huggingface.co/msbayindir/rag-chunker-models), unmodified PaddleOCR exports with their licences) to `~/.rag-chunker/models` on first use (override with `RAG_CHUNKER_MODELS_DIR`) and verified by hash. Cost: about one second per page on a laptop CPU, cached per page. `rag-chunker doctor` shows whether the runtime and model are ready; `--dry-run` shows what a run would use.

**Tables.** Tables in a PDF text layer are rebuilt as tables: grids drawn with lines (including merged cells and two-row headers), tables between horizontal rules only (papers) and tables with no lines at all, found from aligned columns. With `--layout`, table regions that no drawn grid explains also go through [SLANet_plus](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/table_structure_recognition.en.md), an 8 MB table-structure model: it predicts rows, columns and spans from the image, the page text is matched into its cells, and it is used where it explains more of the text than alignment does, which is how scanned pages, images and tables with multi-level headers get a structure (it also splits narrow columns that alignment merged between rules). `table.source` in `document.json` names the detector (`ruled`, `rules`, `aligned`, `model`). They become GFM tables in `document.md` and table chunks (a short table travels with its caption; a long one is split with its header row repeated). `document.json` keeps the cell structure with spans (`table.cells`, `tableToHtml()` renders it with `colspan`/`rowspan`); a table that runs onto the next page gets its header carried over and the two parts are linked (`continues`). `teds()` measures a recognised table against a reference (TEDS, 0–1).

**Figures.** Pictures embedded in PDF pages are cut out of a page render as PNG files (`figures/p<page>-<n>.png`, next to the other outputs) and referenced from `document.md` where they sit in the reading order: `![caption](figures/p3-1.png)`. The caption comes from the `figure_title` region when layout analysis ran, else from the nearest line that starts like one ("Figure 3", "Fig. 2a", "Şekil 1", "Abbildung 4"…) below or above the picture; the caption text itself stays in the flow. With `--layout`, charts and drawings made of vector graphics are figures too (`image` and `chart` regions), which is what papers mostly contain; without it only raster images are found. Icons, logos, full-page scans and pictures with paragraphs written over them are left out. `document.json` lists every figure as a `figure` block with its box, file, caption and (with `--describe-figures`) the description a vision model wrote — `--local` uses Gemma 4 for that, so a chart's axes, legend and trend become searchable text under the image. `rag-chunker inspect --ui` shows the figures inline.

**Reranking (local, no keys).** `rag-chunker eval <dir> --rerank` and `rag-chunker mcp <dir> --rerank` add a second stage to search: the best 30 candidates of hybrid (or BM25) search go through a cross-encoder that reads the query and each chunk together and scores how well the chunk answers it. The default model is [mMARCO mMiniLMv2-L12](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1) (118M parameters, int8 ONNX, 120 MB, Apache-2.0, trained on 14 languages and usable beyond them) on `onnxruntime-node`, with its SentencePiece tokenizer implemented in the package; it takes about 20 ms per pair on a laptop CPU. Once downloaded, `auto` uses it; `rerank.engine` picks another model or turns it off. `eval` reports a `rerank` mode next to `bm25`, `vector` and `hybrid` so the gain is visible on your own documents.

**Quality report.** Every run writes `quality` into `manifest.json`: pages by source and OCR confidence, blocks that do not read like text, heading depth and skipped levels, tables by detector and sparse ones, figures with and without captions, chunk sizes and how many have positions — plus `flags`, plain-language findings such as "3 page(s) without text — scanned pages need an OCR engine" or "2 table(s) with mostly empty cells". `rag-chunker process` prints the first findings, `rag-chunker inspect <dir>` all of them.

**Benchmark.** `npm run bench` runs the package on five public documents (the Turkish constitution, a Turkish hypertension guideline and diabetes protocol, the BERT and Llama 2 papers; fetched from their original addresses and checked by sha256, never redistributed) and evaluates them on fixed question sets in `bench/questions/`. It prints a table (pages, time, chunks, headings, tables, figures, MRR per search mode) and writes `bench/results/<date>-<label>.json`; `--embedding <model>` adds vector/hybrid, `--rerank` the reranker, `--layout`/`--no-layout` toggles the layout model. `bench/README.md` has the corpus card and the latest numbers.

**Comparing runs.** `rag-chunker eval <dirA> <dirB> --compare` evaluates several outputs of the same document on one question set (the first folder's `eval-questions.json`, or `--questions-file`) and shows, per output, MRR and hit@5 with the change against the first, how many questions improved or regressed, and every question whose rank moved; with one folder it compares the search modes the same way. The result is written to `eval-compare.json`.

**Positions.** Chunks read from a PDF text layer carry `boxes`: one rectangle per paragraph, heading or list item, as fractions of the page size (`x`, `y`, `w`, `h`, origin top-left), so an application can highlight the source of an answer on the page at any zoom level. `document.json` has the same positions for every block plus `chunkIds`; `rag-chunker inspect --ui --pdf` draws them over the page. OCR'd pages, DOCX, PPTX, XLSX, HTML and Markdown have no positions (`boxes: []`, `box: null`).

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

## Examples

[`examples/`](examples/) has runnable scripts: the basics, the local layout model with figures and their descriptions, XLSX/HTML inputs, two-stage search with the reranker, `eval --compare` for two chunk sizes, a fully local pipeline, mixed providers, a pgvector query, and the MCP setup for Claude Desktop, Claude Code and Cursor.

## Feedback and contributing

- A document that comes out wrong (missing text, reading order, tables, headings, figures, OCR): open a [document problem](https://github.com/msbayindir/rag-chunker/issues/new/choose) with the quality findings from `rag-chunker inspect <dir>` — that is the single most useful kind of report.
- Questions, ideas and what you built with it: [Discussions](https://github.com/msbayindir/rag-chunker/discussions).
- Security: see [SECURITY.md](SECURITY.md) (private reporting through GitHub).
- Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Adding a provider means implementing the small `LLM` / `Embedder` interfaces in `src/providers/`.

## License

[MIT](LICENSE)
