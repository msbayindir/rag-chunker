# Changelog

## 4.0.0

A rewrite. v4 is not compatible with v3: the API, CLI flags, output fields and cache format all changed.

### Added

- Multi-provider support with `provider/model` references for every stage: Ollama (local, Gemma 4), Gemini, Anthropic Claude, OpenAI, OpenRouter, Mistral and any OpenAI-compatible server (LM Studio, vLLM, gateways).
- `--local`: every stage on Ollama, choosing the best installed Gemma 4 for the machine's memory.
- Tiered OCR: PDF text layer for digital pages (free, no keys), Mistral OCR or any vision model for scanned pages and images; running header/footer and page-number removal.
- New inputs: DOCX, PPTX (slides, tables, speaker notes), PNG/JPEG/WebP and Markdown.
- Contextual retrieval strategies: `full` (whole document, prompt-cached per provider) and `hierarchical` (document + section summaries) for documents larger than the model's context.
- Provider-agnostic heading repair plus a deterministic numbered-heading pass.
- Embeddings for Ollama, Gemini, OpenAI-compatible providers, with batching, caching, input-length protection and query/document prompts.
- Content-addressed cache for OCR pages, summaries and embeddings: interrupted runs resume, re-chunking never repeats OCR.
- CLI commands: `init`, `doctor`, `eval`, `export` (pgvector, Qdrant, LanceDB), `mcp`, `cache`; `process` accepts folders, `--dry-run` and `--json`.
- Inspector UI with search, page images of the original PDF and sanitized markdown.
- MCP server (`search`, `get_chunk`, `get_page`, `list_documents`).
- JSON Schema for the config file (`schema/config.schema.json`).
- Local page layout analysis for PDFs (`--layout`, on with `--local`): PP-DocLayoutV3 through the optional `onnxruntime-node` runtime labels every block (25 classes) and gives the reading order; page furniture and figure labels are dropped, captions/footnotes never become headings, titles do, tables are sought where the model sees them, and `document.json` blocks carry the class as `label`. Models download to `~/.rag-chunker/models` (hash-verified); `doctor` and `--dry-run` report readiness.
- Tables from the PDF text layer: drawn grids (merged cells, multi-row headers, title rows), rule-bounded tables with columns from text alignment, and line-less tables from aligned columns; GFM output, cell structure with spans in `document.json` (`tableToMarkdown`, `tableToHtml`), header carry-over and linking for tables that continue on the next page, and a `teds()` scorer.
- Provenance: chunks from a PDF text layer carry `boxes` (one rectangle per paragraph, heading or list item, as fractions of the page); `document.json` lists every block with its page, position and chunks; the inspector highlights chunks on the page image; `manifest.stages.chunk.located` counts positioned chunks.
- `QUOTA_EXCEEDED` and `RATE_LIMITED` errors with the provider's retry delay and a console hint; `ocr: auto` falls back from Mistral when the key has no OCR quota.
- PDF text layer reading order for two-column papers with narrow gutters and for side-by-side blocks (comparison tables, boxed examples) on single-column pages; headings from font size and font style, with filters for tables of contents, running headers and figure labels.

### Changed

- The chunker slices markdown verbatim: no dropped content, exact `pageStart`/`pageEnd`, table parts repeat the header, code parts keep fences, small chunks merge only within a section and never beyond `maxTokens`, overlap is sentence-based.
- Token counts use the o200k BPE tokenizer instead of `chars / 4`.
- `chunkId` is `documentId prefix + content hash` (unique and stable across runs); chunks carry `documentId`, `source` and `ocrSource`.
- `process()` is now `processDocument(input, config, options)`; configuration is validated with readable errors; API keys come from the environment (or `providers.*.apiKey` in code), never from config files.
- Requires Node.js 22.
- Context batches are runs of consecutive chunks across sections, `auto` switches to `hierarchical` above 60k document tokens, and sections that fit in one chunk get no separate summary. On Ollama a long shared prefix is processed once so llama.cpp can reuse it for every batch (Gemma's sliding-window attention otherwise forces a full re-read per request).
- `--dry-run` estimates context requests and tokens for the strategy that will actually be used.
- Headings after a reference list (“References”, “Kaynaklar”) are no longer nested under it in `sectionPath`.

### Removed

- v3 options (`geminiApiKey`, `mistralApiKey`, `contextMode`, `headingNormalization`, …), the `chunk()` helper, the `ocr` and `chunk` CLI commands and the v3 OCR cache file.
