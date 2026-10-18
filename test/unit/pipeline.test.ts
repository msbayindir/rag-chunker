import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  chunkMarkdown,
  embedQuery,
  type ProgressEvent,
  planDocument,
  processDocument,
  type RagChunkerConfig,
  readOutputDir,
} from '../../src/index.js'
import { PAGE1, SCANNED } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'
import { json, MockServer, type RecordedRequest } from '../helpers/mock-server.js'

const server = new MockServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

const tmp = (p: string) => mkdtemp(join(tmpdir(), p))

function chunkIdsIn(body: any): number[] {
  return [...JSON.stringify(body.messages).matchAll(/<chunk id=\\"(\d+)\\"/g)].map((m) => Number(m[1]))
}

/** A fake Ollama that answers OCR, heading, summary and context prompts plus embeddings. */
function fakeOllama() {
  server.on('POST', '/api/show', (r, res) => {
    const model = (r.body as any).model as string
    if (model === 'embeddinggemma')
      return json(res, 200, { model_info: { 'gemma3.context_length': 2048 }, capabilities: ['embedding'] })
    json(res, 200, {
      model_info: { 'gemma4.context_length': 131072 },
      capabilities: ['completion', 'vision'],
    })
  })
  server.on('POST', '/api/chat', (r: RecordedRequest, res) => {
    const body = r.body as any
    const system = body.messages[0]?.content ?? ''
    let content: string
    if (system.startsWith('You are an OCR engine')) content = `# ${SCANNED.heading}\n\n${SCANNED.paragraph}`
    else if (system.includes('analyse the structure'))
      content = JSON.stringify({
        documentType: 'guideline',
        mainSections: [PAGE1.title],
        recurringBlocks: [],
        notHeadings: [],
        notes: '',
      })
    else if (system.includes('fix heading levels')) content = JSON.stringify({ corrections: [] })
    else if (system.startsWith('You write contextual')) {
      content = JSON.stringify({
        items: chunkIdsIn(body).map((id) => ({
          id,
          context: `Bu parça elektrolit rehberinin ${id}. bölümüdür.`,
        })),
      })
    } else content = JSON.stringify({ summary: 'Özet.' })
    json(res, 200, {
      message: { role: 'assistant', content },
      done: true,
      prompt_eval_count: 100,
      eval_count: 20,
    })
  })
  server.on('POST', '/api/embed', (r, res) => {
    const input = (r.body as any).input as string[]
    json(res, 200, {
      embeddings: input.map((t) => [t.length / 1000, 0.5, 0.25]),
      prompt_eval_count: input.length,
    })
  })
}

describe('processDocument without providers', () => {
  it('turns a PDF into chunks, structure and manifest using only the text layer', async () => {
    const events: ProgressEvent[] = []
    const res = await processDocument(
      fixture('turkish.pdf'),
      { cache: { enabled: false } },
      { env: {}, onProgress: (e) => events.push(e) },
    )
    expect(res.chunks.length).toBeGreaterThan(1)
    expect(new Set(res.chunks.map((c) => c.chunkId)).size).toBe(res.chunks.length)
    const first = res.chunks[0]
    expect(first).toMatchObject({
      source: 'turkish.pdf',
      index: 0,
      ocrSource: 'text-layer',
      contextSummary: '',
      embedding: [],
    })
    expect(first?.documentId).toMatch(/^[0-9a-f]{64}$/)
    expect(first?.content).toBe(first?.rawContent)
    expect(res.chunks.at(-1)?.nextChunkId).toBeNull()
    expect(res.chunks[1]?.prevChunkId).toBe(first?.chunkId)
    expect(res.manifest.stages.ocr).toMatchObject({ engine: 'text-layer', scannedPages: 1 })
    expect(res.manifest.stages.context).toBeNull()
    expect(res.manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(res.warnings.some((w) => w.includes('no usable text layer'))).toBe(true)
    expect(res.structure.headings.map((h) => h.text)).toContain(PAGE1.title)
    expect(events.some((e) => e.type === 'stage-end' && e.stage === 'context' && e.skipped)).toBe(true)

    const dir = await tmp('rc-out-')
    const paths = await res.save(dir)
    const loaded = await readOutputDir(dir)
    expect(loaded.chunks).toEqual(res.chunks)
    expect((await readFile(paths.markdown, 'utf8')).startsWith('<!-- page 1 -->')).toBe(true)
    expect(loaded.manifest.source.name).toBe('turkish.pdf')
  })

  it('processes markdown, DOCX and PPTX inputs', async () => {
    for (const name of ['sample.md', 'sample.docx', 'sample.pptx']) {
      const res = await processDocument(fixture(name), { cache: { enabled: false } }, { env: {} })
      expect(res.chunks.length).toBeGreaterThan(0)
      expect(res.manifest.source.name).toBe(name)
    }
    const pptx = await processDocument(fixture('sample.pptx'), { cache: { enabled: false } }, { env: {} })
    expect(pptx.chunks.at(-1)?.pageEnd).toBe(2)
  })

  it('accepts bytes with a name and honours abort signals', async () => {
    const bytes = new Uint8Array(await readFile(fixture('sample.md')))
    const res = await processDocument(bytes, { cache: { enabled: false } }, { name: 'notlar.md', env: {} })
    expect(res.chunks[0]?.source).toBe('notlar.md')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      processDocument(
        fixture('turkish.pdf'),
        { cache: { enabled: false } },
        { env: {}, signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    })
  })

  it('fails early with a clear error when mistral is forced without a key', async () => {
    await expect(
      processDocument(
        fixture('turkish.pdf'),
        { ocr: { engine: 'mistral' }, cache: { enabled: false } },
        { env: {} },
      ),
    ).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    })
  })
})

describe('processDocument with every stage (fake Ollama)', () => {
  const config = (cacheDir: string): RagChunkerConfig => ({
    providers: { ollama: { baseURL: server.url } },
    models: {
      vision: 'ollama/gemma4:e4b-it-qat',
      structure: 'ollama/gemma4:e4b-it-qat',
      context: 'ollama/gemma4:e4b-it-qat',
      embedding: 'ollama/embeddinggemma',
    },
    chunk: { maxTokens: 256, minTokens: 20 },
    cache: { dir: cacheDir },
  })

  it('runs OCR, structure, context and embeddings, then resumes from cache', async () => {
    fakeOllama()
    const cacheDir = await tmp('rc-cache-')
    const res = await processDocument(fixture('turkish.pdf'), config(cacheDir), { env: {} })
    const all = res.chunks.map((c) => c.rawContent).join('\n')
    expect(all).toContain(SCANNED.heading)
    const scannedChunk = res.chunks.find((c) => c.rawContent.includes(SCANNED.heading))
    expect(scannedChunk?.ocrSource).toBe('ollama/gemma4:e4b-it-qat')
    expect(scannedChunk?.pageStart).toBe(4)
    for (const c of res.chunks) {
      expect(c.contextSummary).toMatch(/elektrolit rehberinin \d+\. bölümüdür/)
      expect(c.content.startsWith(`Context: ${c.contextSummary}\n\n`)).toBe(true)
      expect(c.embedding).toHaveLength(3)
    }
    expect(res.manifest.stages.context).toMatchObject({ strategy: 'full', failed: 0 })
    expect(res.manifest.stages.embedding).toMatchObject({ model: 'ollama/embeddinggemma', dimensions: 3 })
    expect(res.manifest.stages.structure).toMatchObject({ documentType: 'guideline' })
    expect(res.manifest.usage.total.requests).toBeGreaterThan(3)
    const embedReq = server.requests.find((r) => r.path === '/api/embed')?.body as any
    expect(embedReq.input[0]).toMatch(/^title: none \| text: Context: /)

    const before = server.requests.filter((r) => r.path === '/api/chat' || r.path === '/api/embed').length
    const again = await processDocument(fixture('turkish.pdf'), config(cacheDir), { env: {} })
    const after = server.requests.filter((r) => r.path === '/api/chat' || r.path === '/api/embed').length
    expect(after).toBe(before)
    expect(again.chunks).toEqual(res.chunks)
    expect(again.manifest.stages.ocr.cachedPages).toBe(1)
    expect(again.manifest.stages.context?.cached).toBe(res.chunks.length)
  })

  it('embeds queries with the query prefix', async () => {
    fakeOllama()
    const v = await embedQuery('hiponatremi tedavisi', 'ollama/embeddinggemma', {
      config: { providers: { ollama: { baseURL: server.url } }, cache: { enabled: false } },
      env: {},
    })
    expect(v).toHaveLength(3)
    const body = server.requests.find((r) => r.path === '/api/embed')?.body as any
    expect(body.input).toEqual(['task: search result | query: hiponatremi tedavisi'])
  })
})

describe('planDocument and chunkMarkdown', () => {
  it('reports what a run would do without calling providers', async () => {
    const plan = await planDocument(
      fixture('turkish.pdf'),
      { models: { context: 'ollama/gemma4:e4b-it-qat', embedding: 'ollama/embeddinggemma' } },
      { env: {} },
    )
    expect(plan).toMatchObject({ pages: 4, scannedPages: 1, ocr: { engine: 'text-layer', pagesToOcr: 0 } })
    expect(plan.estimatedChunks).toBeGreaterThan(0)
    expect(plan.context).toMatchObject({ strategy: 'full' })
    expect(plan.context?.estimatedRequests).toBeGreaterThan(0)
    expect(plan.context?.estimatedInputTokens).toBeGreaterThan(plan.documentTokens)
    expect(plan.embedding?.texts).toBe(plan.estimatedChunks)
    expect(plan.warnings.join(' ')).toMatch(/scanned/)
    expect(server.requests).toHaveLength(0)
  })

  it('plans Mistral OCR for all pages when a key is present', async () => {
    const plan = await planDocument(fixture('turkish.pdf'), {}, { env: { MISTRAL_API_KEY: 'k' } })
    expect(plan.ocr).toEqual({ engine: 'mistral', pagesToOcr: 4 })
  })

  it('chunks markdown strings directly', () => {
    const chunks = chunkMarkdown('# Başlık\n\nBirinci paragraf.\n\n## Alt\n\nİkinci paragraf.', {
      minTokens: 0,
      source: 'not.md',
    })
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      source: 'not.md',
      sectionPath: ['Başlık'],
      pageStart: 1,
      ocrSource: 'markdown',
    })
  })
})

describe('automatic OCR fallback', () => {
  it('moves on to the text layer when an automatically chosen Mistral has no quota', async () => {
    server.on('POST', '/v1/ocr', (_r, res) =>
      json(res, 429, { message: 'Rate limit exceeded' }, { 'x-ratelimit-limit-req-minute': '0' }),
    )
    const config = { providers: { mistral: { baseURL: `${server.url}/v1` } }, cache: { enabled: false } }
    const res = await processDocument(fixture('turkish.pdf'), config, { env: { MISTRAL_API_KEY: 'k' } })
    expect(res.manifest.stages.ocr.engine).toBe('text-layer')
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.warnings.some((w) => w.includes('Mistral OCR is not usable'))).toBe(true)
    // An explicit choice still fails loudly.
    await expect(
      processDocument(
        fixture('turkish.pdf'),
        { ...config, ocr: { engine: 'mistral' } },
        { env: { MISTRAL_API_KEY: 'k' } },
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })
})
