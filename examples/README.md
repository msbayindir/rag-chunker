# Examples

| File | What it shows |
|---|---|
| `basic.mjs` | Process a document with no keys and print the chunks |
| `local.mjs` | Fully local pipeline on Ollama (Gemma 4 + EmbeddingGemma) and a hybrid search |
| `mixed-providers.mjs` | Mistral OCR + Gemini context + local embeddings, with progress output |
| `pgvector-query.mjs` | Query chunks exported with `rag-chunker export --to pgvector` |
| `rag-chunker.config.json` | A config file you can copy |

Run them from a project where `@msbayindir/rag-chunker` is installed: `node examples/basic.mjs path/to/file.pdf`.
