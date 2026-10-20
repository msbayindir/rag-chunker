# Changelog

## 4.1.0 — 2026-10-20

Stronger local models behind a `local.profile` switch (`full` by default, `basic` for the small
ones): the PP-OCRv5 server text detector, automatic Chinese/Japanese recognition, display formulas as
LaTeX (texify2), and bge-reranker-v2-m3 for search; CoreML/CUDA for the models that gain from it. On
the same 200 English OmniDocBench pages the text edit distance drops from 0.256 to 0.134; on the full
1,651-page set the official scorer gives text 0.165, table TEDS 54.8, reading order 0.218. Search MRR
on FinanceBench rises from 0.216 to 0.329. Numbers and how they were measured: README "Benchmarks"
and bench/README.md.

- Benchmarks: results for OmniDocBench (official scorer, full set), FinanceBench, SQuAD-TR and scanned Turkish documents in the README and `bench/README.md`, per-page scores in `bench/results/external/`; `bench-omnidocbench --pages-file` for page names that contain commas.
- Images read by the local OCR are composed again on every run: the cache used to keep the finished page text of an image, so a rerun lost the page size and block positions and kept tables from an earlier table-model or layout setting. The recogniser's lines are now cached instead, as for scanned PDF pages.
- Reranker per profile: `rerank.engine: auto` now stands for `bge-reranker-v2-m3` under the `full` profile and `mmarco-minilm` under `basic`. On the saved FinanceBench chunks (150 questions over 83 filings, 30 hybrid candidates) the m3 model lifts the evidence-chunk MRR from 0.216 to 0.329 within a filing and from 0.169 to 0.288 across all filings; on 100 Turkish SQuAD-TR questions from 0.876 to 0.938 (first hit 81 % → 91 %). It costs seconds per query on a CPU, so `--profile basic` or `rerank.candidates: 15` keep search quick; an installation that only has MiniLM downloaded keeps using it until `--rerank` fetches the profile's model. `doctor` names the profile's reranker.
- Examples for the local layout model with figures and descriptions, XLSX/HTML inputs, two-stage search with the reranker, `eval --compare` for two chunk sizes, and the MCP setup for Claude Desktop, Claude Code and Cursor; README links them.
- Feedback channels: a "document problem" issue template, Discussions, `SECURITY.md` with private vulnerability reporting; `doctor` and error messages that look like bugs link to the issue tracker.
- Figure captions fall back to the caption-line heuristic when layout analysis finds no caption region next to a figure.
- Scanned multi-column pages: words that sit on one baseline but in different layout regions no longer merge into one line, so columns stay apart (OmniDocBench English subset: text edit distance 0.256 → 0.161 with the same models).
- Local OCR: a second detection pass at higher resolution when the first one finds only tiny lines (dense newspaper scans; `RAG_CHUNKER_OCR_DET_MIN_LINE`, default 12 px, 0 disables), and OCR line heights within 0.8–1.28× of the page's body height count as body height, so the detector's quantised heights no longer turn paragraph lines into headings.
- `RAG_CHUNKER_THREADS` (ONNX threads), `RAG_CHUNKER_OCR_DET_LIMIT` (detector input size, default 960) and `RAG_CHUNKER_OCR_DET_MODEL=server` (the 88 MB PP-OCRv5 server detector, now in the model catalogue) as environment knobs until they become config options.
- Formula recognition (`formulas.recognize`, CLI `--no-formulas`): display-formula regions found by the layout model are cropped from the page render and read as LaTeX by texify2 (vikp/texify2, CC-BY-SA-4.0; 8-bit ONNX, 320 MB, through the optional `@huggingface/transformers` package), replacing the OCR gibberish those regions produced; the LaTeX is written as `$$…$$` blocks in `document.md`. On with the `full` profile when layout analysis runs and the package is installed.
- `local.device` (`auto`/`cpu`/`coreml`/`cuda`): the OCR text detector and the CJK recogniser run on CoreML (macOS) or CUDA when `onnxruntime-node` offers them, with a CPU fallback per model; the other models stay on the CPU, where they measured faster. On an M1 the server detector runs about 4× faster on CoreML.
- Chinese and Japanese scans: `ocr.script` (`auto`/`latin`/`cjk`). With the `full` profile the PP-OCRv5 server recogniser (84 MB, Chinese + Japanese + English) is downloaded, the widest lines of a document's first scanned page are read with it, and the document switches to it when they come back as CJK text; Latin-script documents (Turkish included) keep the Latin model, which reads them better and ten times faster. The copy of the server dictionary on the public ONNX mirror is broken (an extra line shifts every character); the catalogue uses PaddleOCR's own file.
- `local.profile` (`full` by default, `basic` for the small models; CLI `--profile`) and `ocr.detector` (`auto`/`mobile`/`server`). The `full` profile runs the PP-OCRv5 server text detector (84 MB, mirrored on Hugging Face): on scanned Turkish documents the character error rate drops from 13.2 % to 10.1 % (guideline) and 2.5 % to 1.5 % (constitution), at about 1.8× the OCR time. `doctor` shows which detectors are downloaded.
- External benchmark runners under `scripts/`: OmniDocBench (`bench-omnidocbench.mjs`, our port of the end-to-end protocol with the official text normalisation), FinanceBench (`bench-financebench.mjs`) and SQuAD-TR (`bench-squad-tr.mjs`); `src/eval/metrics.ts` holds the shared metrics (edit distances, LaTeX-to-text, HTML tables to TEDS input).

## 4.0.0

A rewrite. v4 is not compatible with v3: the API, CLI flags, output fields and cache format all changed.

### Added

- Multi-provider support with `provider/model` references for every stage: Ollama (local, Gemma 4), Gemini, Anthropic Claude, OpenAI, OpenRouter, Mistral and any OpenAI-compatible server (LM Studio, vLLM, gateways).
- `--local`: every stage on Ollama, choosing the best installed Gemma 4 for the machine's memory.
- Tiered OCR: PDF text layer for digital pages (free, no keys), Mistral OCR or any vision model for scanned pages and images; running header/footer and page-number removal.
- New inputs: DOCX, PPTX (slides, tables, speaker notes), XLSX (one page per sheet, cell blocks as tables with dates, percentages and merged cells resolved), HTML (main content without navigation and chrome), PNG/JPEG/WebP and Markdown.
- Hosted rerankers through the provider system: `rerank.engine: "cohere/rerank-v3.5"` or `"jina/…"` (COHERE_API_KEY / JINA_API_KEY), same two-stage search as the local model.
- Local OCR keeps word positions inside each line (from the recogniser's time steps), so side-by-side cells of scanned tables are split correctly.
- `npm run bench`: a repeatable benchmark on five public documents with fixed question sets (`bench/`), results as JSON and a markdown table; `scripts/hf-mirror.mjs` publishes the ONNX models to a project-owned Hugging Face repo with a generated model card; the layout, OCR and table models download from https://huggingface.co/msbayindir/rag-chunker-models.
- Local reranking: `eval --rerank` and `mcp --rerank` reorder the top 30 hybrid/BM25 candidates with a cross-encoder on `onnxruntime-node` (default mMARCO mMiniLMv2-L12, 120 MB, Apache-2.0; also `bge-reranker-base`, `bge-reranker-v2-m3`), with an in-package SentencePiece Unigram tokenizer; `rerank.engine`/`rerank.candidates`, `rerank` mode in eval reports, `doctor` check, `rerank()` in the API.
- Quality report in `manifest.json` (`quality`): page sources, OCR confidence, garbled blocks, heading depth and level skips, tables by detector and sparse tables, figures with captions, chunk sizes and positions, plus plain-language `flags`; shown by `process` and `inspect`.
- `eval --compare`: per-output (or per-mode) MRR/hit@5 deltas, improved/regressed counts and the questions whose rank moved, written to `eval-compare.json`.
- Figures: pictures in PDF pages (and, with layout analysis, charts and drawings) are cut out as `figures/p<page>-<n>.png`, referenced from the markdown in reading order with their caption as alt text, listed in `document.json` as `figure` blocks and shown in the inspector; `figures.describe` / `--describe-figures` adds a vision-model description under each image (cached); `--no-figures` turns extraction off.
- Contextual retrieval strategies: `full` (whole document, prompt-cached per provider) and `hierarchical` (document + section summaries) for documents larger than the model's context.
- Provider-agnostic heading repair plus a deterministic numbered-heading pass.
- Embeddings for Ollama, Gemini, OpenAI-compatible providers, with batching, caching, input-length protection and query/document prompts.
- Content-addressed cache for OCR pages, summaries and embeddings: interrupted runs resume, re-chunking never repeats OCR.
- CLI commands: `init`, `doctor`, `eval`, `export` (pgvector, Qdrant, LanceDB), `mcp`, `cache`; `process` accepts folders, `--dry-run` and `--json`.
- Inspector UI with search, page images of the original PDF and sanitized markdown.
- MCP server (`search`, `get_chunk`, `get_page`, `list_documents`).
- JSON Schema for the config file (`schema/config.schema.json`).
- Local OCR for scanned pages and images (`--ocr pp-ocr`, on with `--local`, preferred by `auto` once downloaded): PP-OCRv5 mobile detection + Latin recognition on `onnxruntime-node` (13 MB), lines with confidence fed into the same page pipeline as the text layer (headings, tables by alignment, layout regions, positions); an automatically chosen engine that fails hands over to the next one.
- Local page layout analysis for PDFs (`--layout`, on with `--local`): PP-DocLayoutV3 through the optional `onnxruntime-node` runtime labels every block (25 classes) and gives the reading order; page furniture and figure labels are dropped, captions/footnotes never become headings, titles do, tables are sought where the model sees them, and `document.json` blocks carry the class as `label`. Table regions that no drawn grid explains also go through SLANet_plus (8 MB table structure model): its rows, columns and spans are used where they explain more of the text than alignment does (scanned pages, images, nested headers; columns between rules are refined by it), and `table.source` names the detector (`ruled`, `rules`, `aligned`, `model`). Models download to `~/.rag-chunker/models` (hash-verified); `doctor` and `--dry-run` report readiness.
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
