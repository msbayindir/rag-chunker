#!/usr/bin/env bash
# ./examples/compare-chunking.sh paper.pdf [provider/model-for-questions]
#
# Is 256 or 512 tokens per chunk better for this document? Process it both ways, write one question
# set from the first run and evaluate both on it. The comparison lists MRR/hit@5 with the delta
# against the first folder and every question whose rank moved. Needs a model for the questions
# (default: ollama/gemma4:e4b-it-qat); vector/hybrid modes appear when the outputs have embeddings.
set -euo pipefail
pdf="${1:?usage: compare-chunking.sh <pdf> [provider/model]}"
model="${2:-ollama/gemma4:e4b-it-qat}"
name="$(basename "${pdf%.*}")"

npx @msbayindir/rag-chunker process "$pdf" --max-tokens 512 -o "out/$name-512"
npx @msbayindir/rag-chunker process "$pdf" --max-tokens 256 --min-tokens 32 -o "out/$name-256"

# The first folder's eval-questions.json is reused by the second: same questions, fair comparison.
npx @msbayindir/rag-chunker eval "out/$name-512" "out/$name-256" --model "$model" --questions 40 --compare

# Other things worth comparing the same way: --layout vs --no-layout, with and without a context
# model (--context …), or two embedding models (--embedding …).
