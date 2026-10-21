#!/usr/bin/env node
/**
 * Mirrors the local ONNX models to a Hugging Face model repo owned by the project, with a model
 * card and licence files generated from the catalogue in src/local/models.ts.
 *
 *   node scripts/hf-mirror.mjs <user-or-org>/<repo> [--models <dir>] [--only layout,ocr,table,orientation] [--dry-run]
 *
 * Needs HF_TOKEN (a write token) in the environment or .env, the models downloaded (run
 * `rag-chunker process x.pdf --layout --ocr pp-ocr` once, or point --models at the folder) and the
 * package built (dist/). Files are uploaded through the Hub's LFS batch and commit APIs; nothing
 * else is installed. Files whose sha256 is already on the Hub are skipped.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const repoArg = args.find((a) => !a.startsWith('--'))
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')
if (!repoArg) {
  console.error(
    'usage: node scripts/hf-mirror.mjs [<user-or-org>/]<repo> [--models <dir>] [--only layout,ocr,table,orientation] [--dry-run]',
  )
  process.exit(2)
}
/** `<repo>` alone goes under the token owner's account (resolved below). */
let repo = repoArg.includes('/') ? repoArg : ''

const HUB = 'https://huggingface.co'
const { MODELS, modelsDir } = await import(pathToFileURL(join(process.cwd(), 'dist/local/models.js')).href)
const { readDotEnv } = await import(pathToFileURL(join(process.cwd(), 'dist/index.js')).href)
const env = { ...(await readDotEnv(join(process.cwd(), '.env')).catch(() => ({}))), ...process.env }
const token = env.HF_TOKEN
const dir = flag('--models') ?? modelsDir(env)

/** Which catalogue entries go to the mirror, grouped the way the card presents them. */
const GROUPS = {
  layout: { title: 'Page layout', ids: ['pp-doclayout-v3'] },
  ocr: {
    title: 'OCR',
    ids: [
      'pp-ocrv5-det',
      'pp-ocrv5-det-server',
      'pp-ocrv5-rec-latin',
      'pp-ocrv5-dict-latin',
      'pp-ocrv5-rec-server',
      'pp-ocrv5-dict-server',
    ],
  },
  table: { title: 'Table structure', ids: ['slanet-plus', 'slanet-dict'] },
  orientation: { title: 'Page orientation', ids: ['pp-lcnet-doc-ori'] },
  formula: {
    title: 'Formula recognition',
    ids: [
      'texify2-config',
      'texify2-generation',
      'texify2-preprocessor',
      'texify2-tokenizer',
      'texify2-tokenizer-config',
      'texify2-encoder',
      'texify2-decoder',
    ],
  },
}
const only = flag('--only')?.split(',') ?? Object.keys(GROUPS)
const specs = only.flatMap((g) => (GROUPS[g]?.ids ?? []).map((id) => MODELS[id])).filter(Boolean)
if (specs.length === 0) {
  console.error(`nothing to mirror for --only ${only.join(',')}`)
  process.exit(2)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

// ── Stage the files and check them against the catalogue ──────────────────────────────────────
const files = []
for (const spec of specs) {
  const path = join(dir, spec.file)
  const info = await stat(path).catch(() => null)
  if (!info) {
    console.error(`missing ${path} — download it first (rag-chunker process … --layout --ocr pp-ocr)`)
    process.exit(1)
  }
  const bytes = await readFile(path)
  const hash = sha256(bytes)
  if (hash !== spec.sha256 || bytes.length !== spec.bytes) {
    console.error(
      `${spec.file}: sha256/size differ from the catalogue (${hash.slice(0, 12)}…, ${bytes.length} bytes)`,
    )
    process.exit(1)
  }
  files.push({ spec, bytes, hash, lfs: bytes.length > 1_000_000 })
}

// ── Model card, licence and notice ────────────────────────────────────────────────────────────
const sourceOf = (spec) => spec.url.replace(/\/[^/]+$/, '')
const rows = files
  .map(
    ({ spec }) =>
      `| \`${spec.file}\` | ${spec.description} | ${mb(spec.bytes)} | ${spec.license} | [source](${spec.url}) | \`${spec.sha256}\` |`,
  )
  .join('\n')
const readme = `---
license: apache-2.0
library_name: onnxruntime
tags:
  - onnx
  - rag-chunker
  - document-layout
  - ocr
  - table-structure-recognition
  - paddleocr
---

# rag-chunker models

ONNX models that [rag-chunker](https://github.com/msbayindir/rag-chunker) downloads on first use for
local page layout analysis, OCR and table structure recognition. They are unmodified exports of
PaddleOCR / PP-StructureV3 models (Apache-2.0); this repository only keeps them at a stable address
with their checksums, so the tool keeps working whatever happens to the original mirrors.

rag-chunker verifies the sha256 of every download against the catalogue in its source
(\`src/local/models.ts\`), so a changed file is rejected.

| File | What it is | Size | Licence | Original | sha256 |
| --- | --- | --- | --- | --- | --- |
${rows}

## Usage

Nothing to do by hand: \`npx @msbayindir/rag-chunker process paper.pdf --layout --ocr pp-ocr\`
fetches what it needs into \`~/.rag-chunker/models\` (\`RAG_CHUNKER_MODELS_DIR\` changes the folder).
To use the files directly, load them with onnxruntime; the pre- and post-processing rag-chunker
applies (input sizes, normalisation, dictionaries, decoding) is in \`src/local/layout.ts\`,
\`src/local/ocr.ts\` and \`src/local/table.ts\`.

## Credits and licences

The models were trained and released by the PaddlePaddle / PaddleOCR team under the Apache License 2.0
(see \`LICENSE\` and \`NOTICE\`). The ONNX exports come from ${[...new Set(files.map(({ spec }) => sourceOf(spec)))].map((s) => `<${s}>`).join(' and ')}.
This mirror adds nothing of its own.
`
const notice = `rag-chunker models — NOTICE

This repository redistributes, unmodified, model files released under the Apache License 2.0:

${files.map(({ spec }) => `- ${spec.file}: ${spec.license}\n  from ${spec.url}`).join('\n')}

PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR (Apache-2.0)
`
const license = await fetch('https://www.apache.org/licenses/LICENSE-2.0.txt').then((r) => r.text())

const plan = [
  ...files.map((f) => ({ path: f.spec.file, size: f.bytes.length, lfs: f.lfs })),
  { path: 'README.md', size: Buffer.byteLength(readme), lfs: false },
  { path: 'NOTICE', size: Buffer.byteLength(notice), lfs: false },
  { path: 'LICENSE', size: Buffer.byteLength(license), lfs: false },
]
console.log(`Mirror → ${HUB}/${repo || `<you>/${repoArg}`}`)
for (const p of plan) console.log(`  ${p.lfs ? 'lfs ' : 'file'}  ${p.path.padEnd(44)} ${mb(p.size)}`)
if (dryRun) {
  console.log('\n--dry-run: nothing uploaded. Model card:\n')
  console.log(readme)
  process.exit(0)
}
if (!token) {
  console.error(
    'HF_TOKEN is not set (create a write token at https://huggingface.co/settings/tokens and put HF_TOKEN=… in .env)',
  )
  process.exit(1)
}

// ── Hub API ───────────────────────────────────────────────────────────────────────────────────
const auth = { Authorization: `Bearer ${token}` }
async function api(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// Create the repo (409 = exists); a bare name lands under the token owner's account.
const me = await api('/api/whoami-v2')
if (!repo) repo = `${me.name}/${repoArg}`
const [owner, name] = repo.split('/')
try {
  await api('/api/repos/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'model',
      name,
      ...(me.name !== owner ? { organization: owner } : {}),
      private: false,
    }),
  })
  console.log(`created ${repo}`)
} catch (err) {
  if (!/409/.test(String(err))) throw err
  console.log(`${repo} exists`)
}

// What is already there (same sha256 → skip the upload).
const existing = new Map()
try {
  const tree = await api(`/api/models/${repo}/tree/main?recursive=true&expand=true`)
  for (const entry of tree) existing.set(entry.path, entry.lfs?.oid ?? null)
} catch {
  // Empty repo.
}

// LFS: ask for upload actions, then PUT the bytes (single or multipart).
const lfsFiles = files.filter((f) => f.lfs && existing.get(f.spec.file) !== f.hash)
if (lfsFiles.length > 0) {
  const batch = await fetch(`${HUB}/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      ...auth,
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
    },
    body: JSON.stringify({
      operation: 'upload',
      transfers: ['basic', 'multipart'],
      hash_algo: 'sha256',
      objects: lfsFiles.map((f) => ({ oid: f.hash, size: f.bytes.length })),
    }),
  })
  if (!batch.ok) throw new Error(`LFS batch → ${batch.status}: ${(await batch.text()).slice(0, 300)}`)
  const { objects } = await batch.json()
  for (const obj of objects) {
    const file = lfsFiles.find((f) => f.hash === obj.oid)
    if (obj.error) throw new Error(`${file.spec.file}: ${obj.error.message}`)
    const upload = obj.actions?.upload
    if (!upload) {
      console.log(`  ${file.spec.file}: already in LFS storage`)
      continue
    }
    process.stdout.write(`  uploading ${file.spec.file} (${mb(file.bytes.length)})… `)
    const header = upload.header ?? {}
    if (header.chunk_size) {
      // Multipart: numbered part URLs in the header, then a completion call with the ETags.
      const chunk = Number(header.chunk_size)
      const parts = Object.entries(header)
        .filter(([k]) => /^\d+$/.test(k))
        .sort(([a], [b]) => Number(a) - Number(b))
      const etags = []
      for (const [num, url] of parts) {
        const i = Number(num) - 1
        const body = file.bytes.subarray(i * chunk, Math.min(file.bytes.length, (i + 1) * chunk))
        const res = await fetch(url, { method: 'PUT', body })
        if (!res.ok) throw new Error(`part ${num} → ${res.status}`)
        etags.push({ partNumber: Number(num), etag: res.headers.get('etag') })
      }
      const done = await fetch(upload.href, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ oid: obj.oid, parts: etags }),
      })
      if (!done.ok)
        throw new Error(`multipart completion → ${done.status}: ${(await done.text()).slice(0, 200)}`)
    } else {
      const res = await fetch(upload.href, { method: 'PUT', headers: header, body: file.bytes })
      if (!res.ok) throw new Error(`PUT → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    if (obj.actions?.verify) {
      const v = await fetch(obj.actions.verify.href, {
        method: 'POST',
        headers: { ...auth, ...(obj.actions.verify.header ?? {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ oid: obj.oid, size: file.bytes.length }),
      })
      if (!v.ok) throw new Error(`verify → ${v.status}`)
    }
    console.log('ok')
  }
}

// One commit with every file: LFS pointers for the models, inline content for the text files.
const ops = [
  { key: 'header', value: { summary: 'rag-chunker models: mirror with model card', description: '' } },
  ...files.map((f) =>
    f.lfs
      ? { key: 'lfsFile', value: { path: f.spec.file, algo: 'sha256', oid: f.hash, size: f.bytes.length } }
      : {
          key: 'file',
          value: { path: f.spec.file, content: f.bytes.toString('base64'), encoding: 'base64' },
        },
  ),
  {
    key: 'file',
    value: { path: 'README.md', content: Buffer.from(readme).toString('base64'), encoding: 'base64' },
  },
  {
    key: 'file',
    value: { path: 'NOTICE', content: Buffer.from(notice).toString('base64'), encoding: 'base64' },
  },
  {
    key: 'file',
    value: { path: 'LICENSE', content: Buffer.from(license).toString('base64'), encoding: 'base64' },
  },
]
const commit = await api(`/api/models/${repo}/commit/main`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-ndjson' },
  body: `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`,
})
console.log(`committed ${commit?.commitOid?.slice(0, 7) ?? ''} → ${HUB}/${repo}`)
console.log('\nNext: point the urls in src/local/models.ts at')
for (const f of files) console.log(`  ${HUB}/${repo}/resolve/main/${f.spec.file}`)
