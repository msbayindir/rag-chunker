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

Numbers from `results/`, Apple M1, Node 22, default `full` profile with layout analysis and the reranker. The run below was made on commit `2a359ed` of the 4.2.0 release branch, before the version number was raised, so it reports 4.0.0; `results/2026-10-18-local-layout.json` is the 4.0.0 baseline it is compared with.

<!-- results:start -->
Run `4.2.0` on 2026-10-21: rag-chunker 4.1.1, darwin-arm64, Node v22.23.2; layout `auto`, embedding `off`, reranker `bge-reranker-v2-m3`, chunks 512/64 tokens.

| Document | Pages | Time | Chunks | Headings | Tables | Figures | MRR bm25 | MRR hybrid | MRR rerank |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| anayasa | 75 | 216.6 s | 257 | 243 | 3 | 0 | 0.764 (hit@1 66%) | – | 0.940 (hit@1 92%) |
| hipertansiyon-2022 | 222 | 297.9 s | 463 | 316 | 43 | 11 | 0.579 (hit@1 46%) | – | 0.847 (hit@1 80%) |
| diyabet-protokol | 101 | 141.9 s | 200 | 202 | 17 | 19 | – | – | – |
| bert | 16 | 25.6 s | 44 | 36 | 8 | 8 | 0.771 (hit@1 63%) | – | 0.916 (hit@1 88%) |
| llama2 | 77 | 115.5 s | 219 | 69 | 62 | 48 | 0.752 (hit@1 66%) | – | 0.854 (hit@1 78%) |

Quality findings per document:
- `anayasa`: 3 block(s) with few letters (broken text layer or OCR noise), e.g. page 38; 1 heading(s) longer than 120 characters — probably body text; 47 chunk(s) (18 %) below minTokens
- `hipertansiyon-2022`: 8 page(s) without text — scanned pages need an OCR engine (--ocr pp-ocr, --local or a key); 26 block(s) with few letters (broken text layer or OCR noise), e.g. page 11; 3 heading(s) longer than 120 characters — probably body text; heading levels skip a level 13 time(s); 2 of 11 figure(s) without a caption
- `diyabet-protokol`: 2 page(s) without text — scanned pages need an OCR engine (--ocr pp-ocr, --local or a key); 5 block(s) with few letters (broken text layer or OCR noise), e.g. page 6; 1 heading(s) longer than 120 characters — probably body text; heading levels skip a level 17 time(s); 22 chunk(s) (11 %) below minTokens; 18 of 19 figure(s) without a caption
- `bert`: heading levels skip a level 1 time(s); 2 of 8 figure(s) without a caption
- `llama2`: 20 block(s) with few letters (broken text layer or OCR noise), e.g. page 2; heading levels skip a level 6 time(s)
<!-- results:end -->

Notes on reading the table: "Time" is the whole pipeline with the cache off and without any model
request (text layer, layout model, table structure, figures, chunking); MRR columns compare search
modes on the same chunks — `bm25` is keyword search, `hybrid` fuses it with vector search of the
given embedding model, and `rerank` reorders the top 30 hybrid (or, without embeddings, BM25)
candidates with the local cross-encoder.

What the numbers taught us so far. The reranker gains most where keyword search is weakest (the
Turkish guideline, the constitution). With 4.0.0's mmarco-MiniLM it needed good candidates: on the
Llama 2 paper with BM25-only candidates it ranked worse than BM25 (0.75 → 0.68). bge-reranker-v2-m3,
the `full` profile's reranker since 4.1.0, lifts every document from the same BM25 candidates
(Llama 2 0.75 → 0.85, the guideline 0.58 → 0.85), at several seconds per query on a laptop CPU.
Chunk, heading, table and figure counts are identical to the 4.0.0 baseline: the new OCR, formula and
reranker models did not change how these documents are chunked. With 50 synthetic questions per
document the standard error of an MRR is about 0.03: read differences smaller than that as noise.

## External benchmarks

Three runners measure the pipeline on public, human-labelled sets. None of the data is in the
repository (research or non-commercial licences); each runner says where to fetch it. The results
below are for 4.2.0; the per-page and per-run numbers are in [`results/external/`](results/external/)
(scores only, no text from the data sets).

| Runner | Set | What it measures |
| --- | --- | --- |
| `npm run bench:omnidocbench -- --data <dir> [--language english] [--subset 200] [--pages-file <list>] [--save <dir>] [--from <dir>]` | [OmniDocBench](https://github.com/opendatalab/OmniDocBench) v1.6 page images + `OmniDocBench.json` | Layout + local OCR + table model + reading order end to end: our port of the official protocol — reference blocks matched to ours by box overlap, text normalised edit distance with the official normalisation (inline LaTeX rendered as text, then letters/digits only) plus our stricter one, TEDS/TEDS-S for tables, reading-order edit distance. Formulas are not scored. `--save` keeps each page's output so `--from` re-scores without rerunning the models. |
| `npm run bench:financebench -- --data <dir> [--embedding ollama/embeddinggemma] [--rerank]` | [FinanceBench](https://github.com/patronus-ai/financebench) open split: 150 analyst questions, 84 10-K/10-Q filings with verbatim evidence and page | Retrieval of the evidence chunk after text-layer processing — BM25, vectors, hybrid, reranker — inside the question's own filing and across all filings in one index. |
| `npm run bench:squad-tr -- --data <dir> [--questions 500] [--embedding ollama/embeddinggemma]` | [SQuAD-TR](https://github.com/boun-tabi/squad-tr) dev: 1,204 Turkish Wikipedia paragraphs, 2,346 answerable questions | Turkish retrieval of the source paragraph (paragraph = chunk) by BM25, vectors, hybrid and the reranker. Exercises the search stack, not the chunker. |

The metrics live in `src/eval/metrics.ts` and are unit-tested, including the LaTeX-to-text
rendering against `pylatexenc`, which the official OmniDocBench scorer uses.

### Results (4.2.0)

All runs: Apple M1 (16 GB), 4 ONNX threads, `local.device: auto` (CoreML for the OCR detector),
default `full` profile, cache off, commit `2a359ed` (the 4.2.0 release branch before the version bump).

**OmniDocBench, official scorer.** Every page image of the 1,651-page v1.6 set went through
`processDocument` (layout, local OCR with the per-document Latin/CJK choice, SLANet_plus tables,
texify2 formulas); each page's markdown (page comments removed) was saved as `<image>.md` and scored
with the official `pdf_validation.py` (main branch, 2026-10-19) using its default `end2end` settings
(`quick_match`) without the display-formula metrics, as CDM needs a LaTeX toolchain.

| Pages | Text edit distance ↓ | Table TEDS ↑ | TEDS-S ↑ | Reading-order edit ↓ |
| --- | ---: | ---: | ---: | ---: |
| All 1,651 | **0.165** | **55.2** | **69.2** | **0.218** |
| English (755) | 0.151 | 58.6 | 73.2 | 0.196 |
| Simplified Chinese (765) | 0.156 | 55.7 | 67.2 | 0.230 |
| Mixed English–Chinese (116) | 0.290 | 52.5 | 67.6 | 0.257 |
| Traditional Chinese (13) | 0.369 | 56.9 | 74.0 | 0.429 |

4.1.0 scored 0.165 / 54.8 / 68.5 / 0.218 on the same set with the same scorer. The difference is the
page-orientation step of 4.2.0: 10 pages scanned sideways (tables printed across the page) are read
upright; their tables account for the TEDS gain, the text score of every other page is identical.

Page-averaged like the official end-to-end table, where Marker scores 0.157 / 65.8 / 73.2 / 0.243 and
MinerU's pipeline 0.055 / 81.9 / 88.7 / 0.153 (copied, not re-run). The character-weighted text edit
distance is 0.230. Time per page: 7.1 s (6.9 s for English pages, 7.9 s for Chinese ones).

Things to know when reading these: only page images were given (no PDF text layer); the official
matcher aligns our text to the reference's block structure, so paragraphs that rag-chunker carries
across a column or block boundary on purpose cost edit distance; the formula score is missing.
Our own scorer (box-based matching, same text normalisation) puts the same 200 English pages at
0.256 for 4.0.0 and 0.134 for 4.1.0 — use it to compare versions, not systems.

**Scanned Turkish documents.** Pages of the constitution, the hypertension guideline and the BERT
paper rendered to images and read by the local OCR, compared with their text layer: 1.48 %, 10.07 %
and 2.07 % character error rate (4.0.0: 2.48 %, 13.21 %, 2.26 %).

**FinanceBench.** 150 questions over 83 filings (one of the 84 PDFs could not be downloaded),
11,843 pages, 29,672 chunks, text layer, `ollama/embeddinggemma`; MRR of the evidence chunk (a chunk
on the evidence page ±1 that holds at least half of the evidence words, or is at least 70 %
evidence words):

| Search | Within the filing | All filings, one index |
| --- | ---: | ---: |
| BM25 | 0.221 | 0.110 |
| Vector | 0.278 | 0.222 |
| Hybrid | 0.268 | 0.169 |
| Hybrid + mmarco-MiniLM | 0.216 | 0.169 |
| Hybrid + bge-reranker-base | 0.265 | 0.195 |
| Hybrid + bge-reranker-v2-m3 | **0.329** | **0.288** |
| Hybrid + bge-reranker-v2-m3, 15 candidates | 0.315 | 0.257 |

**SQuAD-TR.** The same 100 Turkish questions (seed 42) over 1,204 paragraphs: BM25 0.780, vector
0.820, hybrid 0.805, mmarco-MiniLM 0.876 (first hit 81 %), bge-reranker-v2-m3 **0.938** (91 %).

To reproduce: fetch the data as each runner's header says, `npm run build`, set
`RAG_CHUNKER_MODELS_DIR` and run the commands above (`--save` keeps each page's output for the
official scorer). Page names that contain commas need `--pages-file`.

## Adding a document

1. Add an entry to `corpus.json` (public URL, sha256, size, language, kind, licence note).
2. Process it once and generate questions: `rag-chunker process doc.pdf -o out && rag-chunker eval out --model <provider/model> --questions 50`, then copy `out/eval-questions.json` to `questions/<name>.json`.
3. Run `npm run bench -- --only <name>` and commit the result file.
