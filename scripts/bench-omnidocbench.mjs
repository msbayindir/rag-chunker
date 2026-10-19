#!/usr/bin/env node
/**
 * OmniDocBench (opendatalab, CVPR 2025) end-to-end run for rag-chunker: every page image goes
 * through the local pipeline (layout model + PP-OCR + table structure), the result is compared
 * with the human annotations and scored the way the benchmark does — text edit distance, table
 * TEDS / TEDS-S and reading order — with our own matching (blocks paired by box overlap).
 *
 *   node scripts/bench-omnidocbench.mjs --data <dir> [--subset 200] [--seed 42]
 *        [--language english] [--source book,magazine] [--pages a.png,b.png]
 *        [--no-layout] [--out results.json]
 *
 * <dir> holds OmniDocBench.json and images/ from https://huggingface.co/datasets/opendatalab/OmniDocBench
 * (research use only; nothing is redistributed). Needs the package built and the local models
 * downloaded (RAG_CHUNKER_MODELS_DIR). RAG_CHUNKER_THREADS=2 keeps a laptop usable meanwhile.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dataDir = flag('--data')
if (!dataDir) {
  console.error(
    'usage: node scripts/bench-omnidocbench.mjs --data <dir> [--subset N] [--language …] [--source …] [--out file]',
  )
  process.exit(2)
}
const subset = Number(flag('--subset') ?? 0) || 0
const seed = Number(flag('--seed') ?? 42)
const languages = flag('--language')?.split(',')
const sources = flag('--source')?.split(',')
const only = flag('--pages')?.split(',')
const layout = !args.includes('--no-layout')
const out =
  flag('--out') ??
  join(root, 'bench', 'results', `omnidocbench-${new Date().toISOString().slice(0, 10)}.json`)
// --save <dir> keeps every page's document.json + markdown; --from <dir> scores those again without
// running the pipeline (scorer changes become free to try).
const saveDir = flag('--save')
const fromDir = flag('--from')
const { mkdir } = await import('node:fs/promises')
if (saveDir) await mkdir(saveDir, { recursive: true })

const dist = (p) => import(pathToFileURL(join(root, 'dist', p)).href)
const { processDocument, readDotEnv } = await dist('index.js')
const { teds } = await dist('eval/teds.js')
const M = await dist('eval/metrics.js')
const { PACKAGE_VERSION } = await dist('output/manifest.js')
const env = { ...(await readDotEnv(join(root, '.env')).catch(() => ({}))), ...process.env }

// ── Ground truth ──────────────────────────────────────────────────────────────────────────────
const TEXT = new Set([
  'text_block',
  'title',
  'figure_caption',
  'table_caption',
  'table_footnote',
  'figure_footnote',
  'page_footnote',
  'reference',
  'code_txt',
  'code_txt_caption',
  'equation_caption',
  'equation_explanation',
])
const annotations = JSON.parse(await readFile(join(dataDir, 'OmniDocBench.json'), 'utf8'))
const polyToBox = (poly, w, h) => {
  const xs = [poly[0], poly[2], poly[4], poly[6]]
  const ys = [poly[1], poly[3], poly[5], poly[7]]
  const x0 = Math.min(...xs) / w
  const y0 = Math.min(...ys) / h
  return { x: x0, y: y0, w: Math.max(...xs) / w - x0, h: Math.max(...ys) / h - y0 }
}
let pages = annotations.map((p) => {
  const { width: w, height: h, image_path: image, page_attribute: attr = {} } = p.page_info
  const blocks = (p.layout_dets ?? [])
    .filter((b) => !b.ignore && Array.isArray(b.poly) && b.poly.length >= 8)
    .map((b) => ({
      category: b.category_type,
      order: typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY,
      box: polyToBox(b.poly, w, h),
      text: typeof b.text === 'string' ? M.cellText(b.text) : '',
      raw: typeof b.text === 'string' ? b.text : '',
      html: typeof b.html === 'string' ? b.html : '',
    }))
  const refText = blocks.map((b) => b.text).join('')
  const letters = (refText.match(/\p{L}/gu) ?? []).length
  const cjk = (
    refText.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []
  ).length
  // The metadata language is not always right (Chinese pages tagged "english"); the text decides.
  const script =
    letters === 0 ? 'none' : cjk / letters > 0.5 ? 'cjk' : cjk / letters > 0.1 ? 'mixed' : 'latin'
  return {
    image,
    source: attr.data_source ?? '?',
    language: attr.language ?? '?',
    layout: attr.layout ?? '?',
    script,
    blocks,
  }
})
if (languages) pages = pages.filter((p) => languages.includes(p.language))
if (sources) pages = pages.filter((p) => sources.includes(p.source))
if (only) pages = pages.filter((p) => only.includes(p.image))
pages = pages.filter((p) => existsSync(join(dataDir, 'images', p.image)))
if (fromDir) pages = pages.filter((p) => existsSync(join(fromDir, `${p.image}.json`)))
if (subset > 0 && pages.length > subset) {
  // Deterministic stratified sample: shuffle, then take pages source by source in turn.
  let a = seed >>> 0
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const shuffled = [...pages].sort((x, y) => x.image.localeCompare(y.image)).sort(() => random() - 0.5)
  const bySource = new Map()
  for (const p of shuffled) (bySource.get(p.source) ?? bySource.set(p.source, []).get(p.source)).push(p)
  const picked = []
  while (picked.length < subset && [...bySource.values()].some((l) => l.length > 0)) {
    for (const list of bySource.values()) {
      const p = list.shift()
      if (p) picked.push(p)
      if (picked.length >= subset) break
    }
  }
  pages = picked
}
if (pages.length === 0) {
  console.error('no pages selected (are the images downloaded?)')
  process.exit(1)
}

// ── Scoring one page ──────────────────────────────────────────────────────────────────────────
const MATCH_IOU = 0.2
// The official rule (OmniDocBench's `normalized_text`): inline LaTeX rendered as text, then only
// letters, digits and underscores kept — spaces, punctuation and symbols never count. `strict` is
// our own stricter view (case-folded, spaces and punctuation count) kept for diagnosis.
const norm = (s) => M.officialNormalize(s)
const strict = (s) => M.normalizeText(s)

function scorePage(gt, result) {
  const layoutPage = result.layout.pages[0]
  const preds = (layoutPage?.blocks ?? [])
    .filter((b) => b.box && b.kind !== 'figure')
    // Stray OCR boxes: a few characters spanning a large part of the page (tables are exempt — their
    // markdown has no plain text by construction).
    .filter(
      (b) => b.kind === 'table' || !(b.box.w * b.box.h > 0.1 && M.markdownToPlainText(b.text).length < 20),
    )
    .map((b, index) => {
      const plain = M.markdownToPlainText(b.text)
      return {
        index,
        kind: b.kind,
        box: b.box,
        text: norm(plain),
        strict: strict(plain),
        table: b.table ?? null,
        gts: [],
      }
    })
  const gtText = gt.blocks.filter((b) => TEXT.has(b.category) && b.text.trim() !== '')
  const gtTables = gt.blocks.filter((b) => b.category === 'table' && b.html)
  const gtIgnored = gt.blocks.filter((b) => !TEXT.has(b.category) && b.category !== 'table')

  const best = (box, candidates) => {
    let top = null
    let topIou = MATCH_IOU
    for (const c of candidates) {
      const v = M.iou(box, c.box)
      if (v > topIou) {
        top = c
        topIou = v
      }
    }
    return top
  }
  // Text: reference and predicted blocks that overlap (one mostly inside the other, or a fair
  // IoU) form groups, so a paragraph we split in two or two we merged into one is compared as a
  // whole — the benchmark's own matching also truncates and merges. Each group contributes the
  // edit distance between its reference text (reference order) and its predicted text (our order).
  const textPreds = preds.filter((p) => p.kind !== 'table')
  // A predicted block inside a reference block is part of it (we split a paragraph); a reference
  // block inside a predicted one is too (we merged several). Stray OCR boxes — a few characters
  // spanning a large part of the page — are dropped beforehand, or they would pull every block
  // into one group.
  const overlaps = (g, p) =>
    M.iou(g.box, p.box) >= 0.3 || M.coverage(p.box, g.box) >= 0.5 || M.coverage(g.box, p.box) >= 0.5
  const parent = new Map()
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)))
      k = parent.get(k)
    }
    return k
  }
  const union = (a, b) => parent.set(find(a), find(b))
  for (let i = 0; i < gtText.length; i++) parent.set(`g${i}`, `g${i}`)
  for (let j = 0; j < textPreds.length; j++) parent.set(`p${j}`, `p${j}`)
  for (let i = 0; i < gtText.length; i++) {
    for (let j = 0; j < textPreds.length; j++) if (overlaps(gtText[i], textPreds[j])) union(`g${i}`, `p${j}`)
  }
  const groups = new Map()
  const groupOf = (key) => {
    const root = find(key)
    let group = groups.get(root)
    if (!group) {
      group = { gts: [], preds: [] }
      groups.set(root, group)
    }
    return group
  }
  for (let i = 0; i < gtText.length; i++) groupOf(`g${i}`).gts.push(gtText[i])
  for (let j = 0; j < textPreds.length; j++) groupOf(`p${j}`).preds.push(textPreds[j])
  let errors = 0
  let denom = 0
  // Character counts behind textED: edits inside matched groups, reference text we missed (per
  // category) and text we produced that nothing explains. `strictErrors` is the same under our
  // stricter normalisation.
  const breakdown = { pairs: 0, missed: 0, extra: 0, missedBy: {} }
  const strictErrors = { pairs: 0, missed: 0, extra: 0, denom: 0 }
  const pairs = []
  const unmatchedGt = []
  const extraPreds = []
  for (const group of groups.values()) {
    if (group.gts.length > 0 && group.preds.length > 0) {
      const sortedGts = group.gts.sort((x, y) => x.order - y.order)
      const ref = norm(sortedGts.map((g) => g.raw).join(' '))
      const refStrict = strict(sortedGts.map((g) => g.text).join(' '))
      // Predicted blocks are concatenated in the order we emitted them. A paragraph we carry
      // across columns in the right order costs nothing (the official matcher, which works on text
      // rather than boxes, would split it too); a wrong order inside the group costs edits, which
      // is stricter than the official text score, where order never counts.
      const ordered = [...group.preds].sort((a, b) => a.index - b.index)
      const pred = ordered.map((p) => p.text).join('')
      const predStrict = ordered.map((p) => p.strict).join(' ')
      const ed = M.levenshtein(ref, pred)
      errors += ed
      breakdown.pairs += ed
      denom += Math.max(ref.length, pred.length)
      const edStrict = M.levenshtein(refStrict, predStrict)
      strictErrors.pairs += edStrict
      strictErrors.denom += Math.max(refStrict.length, predStrict.length)
      pairs.push({ group, ref: refStrict, pred: predStrict, ed: edStrict })
      for (const p of group.preds) p.gts.push(...group.gts)
    } else if (group.gts.length > 0) {
      for (const g of group.gts) {
        const len = norm(g.raw).length
        errors += len
        breakdown.missed += len
        breakdown.missedBy[g.category] = (breakdown.missedBy[g.category] ?? 0) + len
        denom += len
        const lenStrict = strict(g.text).length
        strictErrors.missed += lenStrict
        strictErrors.denom += lenStrict
        unmatchedGt.push(g)
      }
    } else {
      // Predicted text nothing in the reference explains counts as insertions, unless it sits in a
      // region the benchmark ignores (headers, footers, figures, formulas, masks) or in a table.
      for (const p of group.preds) {
        if (p.text.length === 0) continue
        if ([...gtIgnored, ...gtTables].some((g) => M.coverage(p.box, g.box) >= 0.5)) continue
        errors += p.text.length
        breakdown.extra += p.text.length
        denom += p.text.length
        strictErrors.extra += p.strict.length
        strictErrors.denom += p.strict.length
        extraPreds.push(p)
      }
    }
  }
  const textED = denom > 0 ? errors / denom : 0
  const textEDStrict =
    strictErrors.denom > 0
      ? (strictErrors.pairs + strictErrors.missed + strictErrors.extra) / strictErrors.denom
      : 0
  if (args.includes('--debug')) {
    const short = (t) => (t.length > 70 ? `${t.slice(0, 69)}…` : t)
    console.log(`\n=== ${gt.image} (${gt.source}, ${gt.language}) textED ${textED.toFixed(3)}`)
    for (const { group, ref, pred, ed } of pairs)
      console.log(
        `  PAIR ed=${(ed / Math.max(1, ref.length, pred.length)).toFixed(2)} gt×${group.gts.length} pred×${group.preds.length} [${group.gts.map((g) => g.category).join(',')}]\n    GT  : ${short(ref)}\n    PRED: ${short(pred)}`,
      )
    for (const g of unmatchedGt)
      console.log(
        `  MISS [${g.category}] box ${g.box.x.toFixed(2)},${g.box.y.toFixed(2)} ${g.box.w.toFixed(2)}×${g.box.h.toFixed(2)}: ${short(strict(g.text))}`,
      )
    for (const p of extraPreds)
      console.log(
        `  EXTRA [${p.kind}] box ${p.box.x.toFixed(2)},${p.box.y.toFixed(2)} ${p.box.w.toFixed(2)}×${p.box.h.toFixed(2)}: ${short(p.strict)}`,
      )
  }

  // Tables: reference table ↔ predicted table block by overlap; TEDS and TEDS-S, 0 when missed.
  const tablePreds = preds.filter((p) => p.kind === 'table' && p.table)
  const tables = gtTables
    .map((g) => {
      const ref = M.htmlTableToData(g.html)
      if (!ref) return null
      const p = best(g.box, tablePreds)
      if (p) p.gts.push(g)
      return {
        rows: ref.rows,
        cols: ref.cols,
        matched: !!p,
        teds: p ? teds(p.table, ref) : 0,
        tedsS: p ? teds(p.table, ref, { structureOnly: true }) : 0,
      }
    })
    .filter(Boolean)

  // Reading order: the reference ranks of matched blocks, in the order we emitted them.
  const sequence = []
  const emitted = new Set()
  for (const p of preds) {
    for (const g of [...p.gts].sort((x, y) => x.order - y.order)) {
      if (emitted.has(g) || !Number.isFinite(g.order)) continue
      emitted.add(g)
      sequence.push(g.order)
    }
  }
  const orderED = M.readingOrderDistance(sequence)

  return {
    textED,
    textEDStrict,
    textErrors: { ...breakdown, denom },
    strictErrors,
    tables,
    orderED,
    gtBlocks: gtText.length + gtTables.length,
    predBlocks: preds.length,
    matchedBlocks: preds.reduce((n, p) => n + p.gts.length, 0),
    extraBlocks: extraPreds.length,
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────
const config = {
  ocr: { engine: 'pp-ocr', removeHeaderFooter: false },
  layout: { engine: layout ? 'pp-doclayout-v3' : 'off' },
  figures: { extract: false },
  cache: { enabled: false },
}
console.log(
  `OmniDocBench · ${pages.length} page(s) · layout ${layout ? 'on' : 'off'} · rag-chunker ${PACKAGE_VERSION}`,
)
const records = []
const t0 = Date.now()
for (const [i, gt] of pages.entries()) {
  const started = Date.now()
  let score
  let error = null
  try {
    let result
    if (fromDir) {
      const saved = join(fromDir, `${gt.image}.json`)
      if (!existsSync(saved)) throw new Error(`no saved output for ${gt.image}`)
      result = JSON.parse(await readFile(saved, 'utf8'))
    } else {
      result = await processDocument(join(dataDir, 'images', gt.image), config, { env })
      if (saveDir)
        await writeFile(
          join(saveDir, `${gt.image}.json`),
          JSON.stringify({ layout: result.layout, markdown: result.markdown }),
        )
    }
    score = scorePage(gt, result)
  } catch (err) {
    error = String(err?.message ?? err)
    score = {
      textED: 1,
      textEDStrict: 1,
      tables: [],
      orderED: 1,
      gtBlocks: 0,
      predBlocks: 0,
      matchedBlocks: 0,
      extraBlocks: 0,
    }
  }
  records.push({
    image: gt.image,
    source: gt.source,
    language: gt.language,
    layout: gt.layout,
    script: gt.script,
    ms: Date.now() - started,
    error,
    ...score,
  })
  if ((i + 1) % 10 === 0 || i === pages.length - 1) {
    const done = records.length
    const mean = (f) => records.reduce((s, r) => s + f(r), 0) / done
    console.log(
      `  ${String(done).padStart(4)}/${pages.length}  textED ${mean((r) => r.textED).toFixed(3)}  orderED ${mean((r) => r.orderED).toFixed(3)}  ${((Date.now() - t0) / 1000 / done).toFixed(1)} s/page`,
    )
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const summarize = (rs) => {
  const tables = rs.flatMap((r) => r.tables)
  const textED = mean(rs.map((r) => r.textED))
  const tedsMean = mean(tables.map((t) => t.teds))
  return {
    pages: rs.length,
    textED,
    textScore: textED === null ? null : (1 - textED) * 100,
    textEDStrict: mean(rs.map((r) => r.textEDStrict ?? r.textED)),
    tables: tables.length,
    tablesMatched: tables.filter((t) => t.matched).length,
    teds: tedsMean === null ? null : tedsMean * 100,
    tedsS: mean(tables.map((t) => t.tedsS)) === null ? null : mean(tables.map((t) => t.tedsS)) * 100,
    orderED: mean(rs.map((r) => r.orderED)),
    msPerPage: mean(rs.map((r) => r.ms)),
    errors: rs.filter((r) => r.error).length,
  }
}
const groupBy = (key) => {
  const groups = {}
  for (const r of records) {
    if (!groups[r[key]]) groups[r[key]] = []
    groups[r[key]].push(r)
  }
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, summarize(rs)]))
}
const summary = {
  benchmark:
    'OmniDocBench (opendatalab) — rag-chunker port of the end-to-end protocol: blocks matched by box overlap, text normalised edit distance, table TEDS/TEDS-S, reading-order edit distance; formulas not evaluated',
  date: new Date().toISOString(),
  version: PACKAGE_VERSION,
  platform: `${process.platform}-${process.arch}`,
  settings: {
    layout,
    ocr: 'pp-ocr',
    subset: subset || null,
    seed,
    languages: languages ?? null,
    sources: sources ?? null,
  },
  overall: summarize(records),
  byLanguage: groupBy('language'),
  byScript: groupBy('script'),
  bySource: groupBy('source'),
  pages: records,
}
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`)

const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : v.toFixed(d))
const row = (name, s) =>
  `| ${name} | ${s.pages} | ${fmt(s.textScore)} | ${fmt(s.textED, 3)} | ${fmt(s.textEDStrict, 3)} | ${s.tablesMatched}/${s.tables} | ${fmt(s.teds)} | ${fmt(s.tedsS)} | ${fmt(s.orderED, 3)} | ${fmt(s.msPerPage / 1000)} s |`
console.log(
  '\n| Set | Pages | Text score ↑ | Text ED ↓ | Text ED strict ↓ | Tables found | TEDS ↑ | TEDS-S ↑ | Order ED ↓ | Time |',
)
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
console.log(row('all', summary.overall))
for (const [k, s] of Object.entries(summary.byLanguage)) console.log(row(`lang: ${k}`, s))
for (const [k, s] of Object.entries(summary.byScript)) console.log(row(`script: ${k}`, s))
for (const [k, s] of Object.entries(summary.bySource)) console.log(row(`type: ${k}`, s))
console.log(`\nwritten ${out}`)
