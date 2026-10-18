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

### Changed

- The chunker slices markdown verbatim: no dropped content, exact `pageStart`/`pageEnd`, table parts repeat the header, code parts keep fences, small chunks merge only within a section and never beyond `maxTokens`, overlap is sentence-based.
- Token counts use the o200k BPE tokenizer instead of `chars / 4`.
- `chunkId` is `documentId prefix + content hash` (unique and stable across runs); chunks carry `documentId`, `source` and `ocrSource`.
- `process()` is now `processDocument(input, config, options)`; configuration is validated with readable errors; API keys come from the environment (or `providers.*.apiKey` in code), never from config files.
- Requires Node.js 22.

### Removed

- v3 options (`geminiApiKey`, `mistralApiKey`, `contextMode`, `headingNormalization`, …), the `chunk()` helper, the `ocr` and `chunk` CLI commands and the v3 OCR cache file.
