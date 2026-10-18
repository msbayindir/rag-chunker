# Examples

Run the scripts from a project where `@msbayindir/rag-chunker` is installed (`npm i @msbayindir/rag-chunker`), e.g. `node examples/basic.mjs path/to/file.pdf`. Nothing here needs an API key unless the comment at the top of the file says so.

| File | What it shows |
|---|---|
| `basic.mjs` | Process a document with no keys and print the chunks |
| `layout-and-figures.mjs` | Local layout model (blocks, reading order, tables), figures cut out as PNGs, optional figure descriptions by a vision model, the quality report |
| `spreadsheets-and-web.mjs` | XLSX and HTML inputs: sheets as pages, tables as table chunks, web pages without their chrome |
| `search-with-reranker.mjs` | Two-stage search over an output folder: keyword/hybrid candidates reordered by the local cross-encoder |
| `compare-chunking.sh` | `eval --compare`: process a PDF with two chunk sizes and see which one answers the same questions better |
| `local.mjs` | Fully local pipeline on Ollama (Gemma 4 + EmbeddingGemma) and a hybrid search |
| `mixed-providers.mjs` | Mistral OCR + Gemini context + local embeddings, with progress output |
| `pgvector-query.mjs` | Query chunks exported with `rag-chunker export --to pgvector` |
| `mcp-claude-desktop.json` | MCP server entry for Claude Desktop (see below) |
| `rag-chunker.config.json` | A config file you can copy |

## MCP: let an agent search your documents

Process the documents once, then serve the output folder(s) over MCP (stdio). The `search` tool does hybrid search when the chunks have embeddings and the embedding model is reachable, keyword search otherwise, and reorders the top candidates with the local reranker when `--rerank` is given (120 MB, downloaded once).

```bash
npx @msbayindir/rag-chunker process manuals/*.pdf --local -o out      # or without --local: text layer only
npx @msbayindir/rag-chunker mcp ./out --rerank                          # test it by hand: it speaks MCP on stdin/stdout
```

- **Claude Desktop**: merge `mcp-claude-desktop.json` into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) with the absolute path of your output folder.
- **Claude Code**: `claude mcp add docs -- npx -y @msbayindir/rag-chunker mcp /absolute/path/to/out --rerank`
- **Cursor / other clients**: the same `command` + `args` in their MCP settings.

Tools: `search(query, topK?, document?)`, `get_chunk(chunkId, neighbors?)`, `get_page(document, page)`, `list_documents()`.

## Comparing settings

`rag-chunker eval <dirA> <dirB> --compare` evaluates several outputs of the same document on one question set and shows what changed per question. `compare-chunking.sh` does it for two chunk sizes; swap the flags to compare `--layout` vs `--no-layout`, a context model on/off, or two embedding models. The question set is written next to the first output (`eval-questions.json`) and can be reused with `--questions-file`.

## Benchmark

The repository (not the npm package) carries a repeatable benchmark on five public documents: clone it and run `npm run bench`; `bench/README.md` has the corpus card and the latest numbers. Add your own document there to measure a change on it.
