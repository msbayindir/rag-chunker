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
Run `local-layout` on 2026-10-18: rag-chunker 4.0.0, darwin-arm64, Node v22.23.2; layout `auto`, embedding `off`, reranker `mmarco-minilm`, chunks 512/64 tokens.

| Document | Pages | Time | Chunks | Headings | Tables | Figures | MRR bm25 | MRR hybrid | MRR rerank |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| anayasa | 75 | 80.7 s | 257 | 243 | 3 | 0 | 0.764 (hit@1 66%) | – | 0.902 (hit@1 86%) |
| hipertansiyon-2022 | 222 | 255.4 s | 463 | 316 | 43 | 11 | 0.579 (hit@1 46%) | – | 0.748 (hit@1 62%) |
| diyabet-protokol | 101 | 119.0 s | 200 | 202 | 17 | 19 | – | – | – |
| bert | 16 | 21.1 s | 44 | 36 | 8 | 8 | 0.771 (hit@1 63%) | – | 0.874 (hit@1 83%) |
| llama2 | 77 | 114.8 s | 219 | 69 | 62 | 48 | 0.752 (hit@1 66%) | – | 0.679 (hit@1 56%) |

Quality findings per document:
- `anayasa`: 3 block(s) with few letters (broken text layer or OCR noise), e.g. page 38; 1 heading(s) longer than 120 characters — probably body text; 47 chunk(s) (18 %) below minTokens
- `hipertansiyon-2022`: 8 page(s) without text — scanned pages need an OCR engine (--ocr pp-ocr, --local or a key); 26 block(s) with few letters (broken text layer or OCR noise), e.g. page 11; 3 heading(s) longer than 120 characters — probably body text; heading levels skip a level 13 time(s); 3 of 11 figure(s) without a caption
- `diyabet-protokol`: 2 page(s) without text — scanned pages need an OCR engine (--ocr pp-ocr, --local or a key); 5 block(s) with few letters (broken text layer or OCR noise), e.g. page 6; 1 heading(s) longer than 120 characters — probably body text; heading levels skip a level 17 time(s); 22 chunk(s) (11 %) below minTokens; 18 of 19 figure(s) without a caption
- `bert`: heading levels skip a level 1 time(s); 2 of 8 figure(s) without a caption
- `llama2`: 20 block(s) with few letters (broken text layer or OCR noise), e.g. page 2; heading levels skip a level 6 time(s)
<!-- results:end -->

Notes on reading the table: "Time" is the whole pipeline with the cache off and without any model
request (text layer, layout model, table structure, figures, chunking); MRR columns compare search
modes on the same chunks — `bm25` is keyword search, `hybrid` fuses it with vector search of the
given embedding model, and `rerank` reorders the top 30 hybrid (or, without embeddings, BM25)
candidates with the local cross-encoder.

Two things the numbers taught us so far. First, the reranker gains most where keyword search is
weakest (the Turkish guideline, the constitution), and it needs good candidates: on the Llama 2
paper with BM25-only candidates it ranked worse than BM25 (0.75 → 0.68), while with hybrid
candidates it helped (0.74 → 0.79); fusing the reranker's order with the first stage's (RRF, a
weighted blend, fewer candidates) did not change that picture. So give it embeddings when you
can. Second, with 50 synthetic questions per document the standard error of an MRR is about 0.03:
read differences smaller than that as noise.

## External benchmarks

Three runners measure the pipeline on public, human-labelled sets. None of the data is in the
repository (research or non-commercial licences); each runner says where to fetch it. Results are
published separately once reviewed.

| Runner | Set | What it measures |
| --- | --- | --- |
| `npm run bench:omnidocbench -- --data <dir> [--language english] [--subset 200] [--save <dir>] [--from <dir>]` | [OmniDocBench](https://github.com/opendatalab/OmniDocBench) v1.5 page images + `OmniDocBench.json` | Layout + local OCR + table model + reading order end to end: our port of the official protocol — reference blocks matched to ours by box overlap, text normalised edit distance with the official normalisation (inline LaTeX rendered as text, then letters/digits only) plus our stricter one, TEDS/TEDS-S for tables, reading-order edit distance. Formulas are not scored. `--save` keeps each page's output so `--from` re-scores without rerunning the models. |
| `npm run bench:financebench -- --data <dir> [--embedding ollama/embeddinggemma] [--rerank]` | [FinanceBench](https://github.com/patronus-ai/financebench) open split: 150 analyst questions, 84 10-K/10-Q filings with verbatim evidence and page | Retrieval of the evidence chunk after text-layer processing — BM25, vectors, hybrid, reranker — inside the question's own filing and across all filings in one index. |
| `npm run bench:squad-tr -- --data <dir> [--questions 500] [--embedding ollama/embeddinggemma]` | [SQuAD-TR](https://github.com/boun-tabi/squad-tr) dev: 1,204 Turkish Wikipedia paragraphs, 2,346 answerable questions | Turkish retrieval of the source paragraph (paragraph = chunk) by BM25, vectors, hybrid and the reranker. Exercises the search stack, not the chunker. |

The metrics live in `src/eval/metrics.ts` and are unit-tested, including the LaTeX-to-text
rendering against `pylatexenc`, which the official OmniDocBench scorer uses.

## Adding a document

1. Add an entry to `corpus.json` (public URL, sha256, size, language, kind, licence note).
2. Process it once and generate questions: `rag-chunker process doc.pdf -o out && rag-chunker eval out --model <provider/model> --questions 50`, then copy `out/eval-questions.json` to `questions/<name>.json`.
3. Run `npm run bench -- --only <name>` and commit the result file.
