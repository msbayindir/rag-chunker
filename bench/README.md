# rag-chunker benchmark

Five public documents, fixed question sets, one command. The point is that every change to the
pipeline can be measured on the same material, and that anyone can repeat the numbers.

```bash
npm run build
npm run bench                                   # text layer + layout model (if downloaded) + BM25 / local reranker
npm run bench -- --embedding gemini/gemini-embedding-001 --rerank   # adds vector + hybrid, forces the reranker
npm run bench -- --only anayasa,bert --no-layout --label no-layout
```

The PDFs are **not** in the repository: their licences differ, so `scripts/bench.mjs` fetches each
from its original address into `bench/corpus/` (git-ignored) and checks its sha256 against
`corpus.json`. If a source changes the file, the run stops and says so.

## Corpus

| Name | Document | Language | Pages | What it exercises | Questions |
| --- | --- | --- | --- | ---: | ---: |
| `anayasa` | Türkiye Cumhuriyeti Anayasası — [mevzuat.gov.tr](https://www.mevzuat.gov.tr/MevzuatMetin/1.5.2709.pdf) | tr | 75 | numbered articles, long single column, a few ruled tables | 50 |
| `hipertansiyon-2022` | TEMD Hipertansiyon Tanı ve Tedavi Kılavuzu 2022 — [temd.org.tr](https://file.temd.org.tr/Uploads/publications/guides/documents/Hipertansiyon-Kilavuzu-2022.pdf) | tr | 222 | clinical guideline: ruled and line-less tables, charts, boxed lists, two-column parts | 50 |
| `diyabet-protokol` | Erişkin Diyabetli Bireyler İçin Diyabet Tedavi Protokolü (T.C. Sağlık Bakanlığı) — [ekutuphane.saglik.gov.tr](https://ekutuphane.saglik.gov.tr/Home/GetDocument/567) | tr | 101 | treatment protocol: many ruled tables, nested lists | – |
| `bert` | BERT: Pre-training of Deep Bidirectional Transformers (Devlin et al., 2019) — [arXiv 1810.04805](https://arxiv.org/pdf/1810.04805) | en | 16 | two-column paper, rule-bounded tables, vector figures | 40 |
| `llama2` | Llama 2: Open Foundation and Fine-Tuned Chat Models (Touvron et al., 2023) — [arXiv 2307.09288](https://arxiv.org/pdf/2307.09288) | en | 77 | long single-column paper, wide tables, charts, prompt/response boxes | 50 |

The constitution is an official legal text (not copyright-protected under Turkish law); the
guideline and the protocol are free downloads from their publishers; the papers are on arXiv under
its non-exclusive licence. None of them is redistributed here.

## Questions

`questions/<name>.json` holds question sets in the format `rag-chunker eval` writes: each entry is
a question a reader could ask plus the verbatim passage that answers it (`evidence`). They were
generated with Gemini 3.8 Flash from stratified passages of the text-layer output and kept only
when the evidence occurs verbatim in the document, then frozen. A search mode "finds" the answer
when a returned chunk contains the evidence (or a clear majority of it when it straddles chunks).
Metrics: MRR (mean of 1/rank of the first relevant chunk in the top 10, 0 when absent) and
hit@k. Synthetic questions are easier than real user questions, so treat the absolute numbers as an
upper bound and the differences between runs as the signal.

## Results

Numbers from `results/`, rag-chunker 4.0.0, Apple M1 (CPU only), Node 22.

<!-- results:start -->
_Run `npm run bench` to fill this table; the latest JSON files in `results/` are the source._
<!-- results:end -->

Notes on reading the table: "Time" is the whole pipeline without any model request (text layer,
layout model, tables, figures, chunking); MRR columns compare search modes on the same chunks —
`bm25` is keyword search, `hybrid` fuses it with vector search of the given embedding model, and
`rerank` reorders the top 30 hybrid (or BM25) candidates with the local cross-encoder.

## Adding a document

1. Add an entry to `corpus.json` (public URL, sha256, size, language, kind, licence note).
2. Process it once and generate questions: `rag-chunker process doc.pdf -o out && rag-chunker eval out --model <provider/model> --questions 50`, then copy `out/eval-questions.json` to `questions/<name>.json`.
3. Run `npm run bench -- --only <name>` and commit the result file.
