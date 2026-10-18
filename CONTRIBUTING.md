# Contributing

Thanks for helping! Bug reports, documentation fixes, new providers and better heuristics are all welcome.

## Setup

```bash
git clone https://github.com/msbayindir/rag-chunker.git
cd rag-chunker
npm install
npm test          # unit, property-based and mock-server tests (no network, no keys)
```

Useful scripts:

| Script | What it does |
|---|---|
| `npm run check` | Lint (Biome) + typecheck + tests — run before opening a PR |
| `npm run build` | Compile to `dist/` and regenerate `schema/config.schema.json` |
| `npm run test:pack` | Pack the library, install it in a temp folder and run the CLI and API |
| `npm run test:live` | Real model calls: Ollama (needs `gemma4` and `embeddinggemma` pulled), Mistral/Gemini when `MISTRAL_API_KEY` / `GEMINI_API_KEY` are in `.env` |
| `npm run format` | Apply Biome formatting |

Test fixtures (PDFs with Turkish text, a scanned page, DOCX, PPTX) are generated automatically into `test/fixtures/generated/`.

## Layout

```
src/
  chunker/      AST chunker, splitting, tokenizer, ids
  documents/    PDF text layer / rendering, DOCX, PPTX, input detection
  ocr/          OCR orchestration, vision OCR, post-processing
  providers/    LLM + embedding adapters (OpenAI-compatible, Anthropic, Gemini, Ollama, Mistral OCR)
  structure/    heading repair
  context/      contextual retrieval
  embeddings/   batching, caching, input limits
  pipeline/     processDocument, planDocument, progress events
  output/       files, manifest, structure
  search/ eval/ export/ mcp/
  cli/          commands and the inspector UI
```

## Adding a provider

1. Implement `LLM` and/or `Embedder` from `src/providers/types.ts` (`generate`, `capabilities`, `embed`, `maxInputTokens`). Prefer the provider's official SDK as an optional dependency, loaded with `importOptional`.
2. Support structured output (`request.json`) natively when the API offers it, and put `request.prefix` where the provider can cache it.
3. Map errors with `toProviderError` and wrap calls in `withRetry`.
4. Register the type in `src/config/schema.ts` / `src/config/providers.ts` and `src/providers/registry.ts`.
5. Add mock-server tests in `test/unit/providers.test.ts` that check the request shape.

## Guidelines

- Keep the chunker invariants: no lost text, `maxTokens` respected, valid page ranges. The property tests in `test/unit/chunker.test.ts` must stay green.
- Never log or persist API keys. Config files must not contain keys.
- User-facing errors are `RagChunkerError` with a `code` and a `hint` that tells the user what to do.
- Conventional commit messages (`feat:`, `fix:`, `docs:` …) are appreciated.
