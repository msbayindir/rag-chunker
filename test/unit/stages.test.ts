import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CacheStore } from '../../src/cache/store.js'
import { chunkMarkdownDocument } from '../../src/chunker/chunker.js'
import { resolveConfig } from '../../src/config/load.js'
import { enrichChunks, isLowQuality } from '../../src/context/enrich.js'
import { readDocument } from '../../src/documents/input.js'
import { embedTexts } from '../../src/embeddings/embed.js'
import { RagChunkerError } from '../../src/errors.js'
import { extractDocument } from '../../src/ocr/extract.js'
import { Reporter } from '../../src/pipeline/events.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import {
  applyHeadingLevels,
  findHeadings,
  fixHeadings,
  harmonizeNumberedHeadings,
} from '../../src/structure/heading-fix.js'
import { HEADER, PAGE1, SCANNED } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'
import { chunkIds, FakeEmbedder, FakeLLM } from '../helpers/fake-llm.js'
import { json, MockServer } from '../helpers/mock-server.js'

const tmpCache = async () => new CacheStore(await mkdtemp(join(tmpdir(), 'rc-stage-')))

const server = new MockServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

function registry(env: Record<string, string> = {}) {
  return new ProviderRegistry({
    config: resolveConfig({
      providers: { ollama: { baseURL: server.url }, mistral: { baseURL: `${server.url}/v1` } },
    }),
    env,
  })
}

describe('extractDocument', () => {
  it('uses the text layer, warns about scanned pages and strips running headers', async () => {
    const doc = await readDocument(fixture('turkish.pdf'))
    const reporter = new Reporter()
    const res = await extractDocument(doc, {
      engine: { type: 'text-layer' },
      pages: 'scanned',
      minTextChars: 40,
      stripImages: true,
      removeHeaderFooter: true,
      registry: registry(),
      cache: new CacheStore(null),
      reporter,
    })
    expect(res.pageCount).toBe(4)
    expect(res.stats).toMatchObject({ textLayerPages: 4, scannedPages: 1, ocrPages: 0, emptyPages: 1 })
    expect(res.stats.headerFooterLinesRemoved).toBeGreaterThanOrEqual(6)
    expect(res.markdown).not.toContain(HEADER)
    expect(res.markdown).not.toMatch(/Sayfa \d/)
    expect(res.markdown).toContain(`# ${PAGE1.title}`)
    expect(reporter.warnings.join(' ')).toMatch(/1 page\(s\) have no usable text layer/)
    expect(res.ocrModel).toBe('text-layer')
  })

  it('OCRs only scanned pages with a vision model and caches page results', async () => {
    server.on('POST', '/api/show', (_r, res) =>
      json(res, 200, {
        model_info: { 'gemma4.context_length': 131072 },
        capabilities: ['completion', 'vision'],
      }),
    )
    server.on('POST', '/api/chat', (r, res) => {
      const msg = (r.body as any).messages.at(-1)
      expect(msg.images).toHaveLength(1)
      json(res, 200, {
        message: {
          role: 'assistant',
          content: `\`\`\`markdown\n# ${SCANNED.heading}\n\n${SCANNED.paragraph}\n\`\`\``,
        },
        done: true,
      })
    })
    const doc = await readDocument(fixture('turkish.pdf'))
    const cache = await tmpCache()
    const opts = {
      engine: { type: 'vision' as const, ref: 'ollama/gemma4:e4b-it-qat' },
      pages: 'scanned' as const,
      minTextChars: 40,
      stripImages: true,
      removeHeaderFooter: true,
      registry: registry(),
      cache,
      reporter: new Reporter(),
    }
    const res = await extractDocument(doc, opts)
    expect(res.stats).toMatchObject({ ocrPages: 1, textLayerPages: 3, cachedPages: 0 })
    expect(res.pages[3]).toMatchObject({ source: 'ollama/gemma4:e4b-it-qat' })
    expect(res.pages[3]?.markdown).toBe(`# ${SCANNED.heading}\n\n${SCANNED.paragraph}`)
    expect(res.ocrModel).toBe('text-layer+ollama/gemma4:e4b-it-qat')
    const chats = server.requests.filter((r) => r.path === '/api/chat').length
    const again = await extractDocument(doc, opts)
    expect(again.stats.cachedPages).toBe(1)
    expect(server.requests.filter((r) => r.path === '/api/chat').length).toBe(chats)
  })

  it('refuses a vision engine that cannot see images', async () => {
    server.on('POST', '/api/show', (_r, res) =>
      json(res, 200, { model_info: {}, capabilities: ['completion'] }),
    )
    const doc = await readDocument(fixture('turkish.pdf'))
    await expect(
      extractDocument(doc, {
        engine: { type: 'vision', ref: 'ollama/llama3' },
        pages: 'scanned',
        minTextChars: 40,
        stripImages: true,
        removeHeaderFooter: true,
        registry: registry(),
        cache: new CacheStore(null),
        reporter: new Reporter(),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_MISSING' })
  })

  it('sends all pages to Mistral as a page subset and maps results back', async () => {
    server.on('POST', '/v1/ocr', (r, res) => {
      const body = r.body as any
      expect(body.document.document_url.startsWith('data:application/pdf;base64,')).toBe(true)
      json(res, 200, {
        model: 'mistral-ocr-latest',
        pages: [0, 1, 2, 3].map((i) => ({
          index: i,
          markdown: `# Mistral sayfa ${i + 1}\n\n![img-0.jpeg](img-0.jpeg)\n\nGövde metni ${['bir', 'iki', 'üç', 'dört'][i]}.`,
        })),
      })
    })
    const doc = await readDocument(fixture('turkish.pdf'))
    const res = await extractDocument(doc, {
      engine: { type: 'mistral' },
      pages: 'all',
      minTextChars: 40,
      stripImages: true,
      removeHeaderFooter: true,
      registry: registry({ MISTRAL_API_KEY: 'k' }),
      cache: new CacheStore(null),
      reporter: new Reporter(),
    })
    expect(res.stats.ocrPages).toBe(4)
    expect(res.pages.map((p) => p.source)).toEqual(['mistral', 'mistral', 'mistral', 'mistral'])
    expect(res.pages[2]?.markdown).toBe('# Mistral sayfa 3\n\nGövde metni üç.')
    expect(res.ocrModel).toBe('mistral-ocr-latest')
  })

  it('needs an OCR engine for images', async () => {
    const doc = await readDocument(fixture('scan.png'))
    await expect(
      extractDocument(doc, {
        engine: { type: 'text-layer' },
        pages: 'scanned',
        minTextChars: 40,
        stripImages: true,
        removeHeaderFooter: true,
        registry: registry(),
        cache: new CacheStore(null),
        reporter: new Reporter(),
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('reads markdown, DOCX and PPTX without providers', async () => {
    for (const [name, source, pages] of [
      ['sample.md', 'markdown', 1],
      ['sample.docx', 'docx', 1],
      ['sample.pptx', 'pptx', 2],
    ] as const) {
      const res = await extractDocument(await readDocument(fixture(name)), {
        engine: { type: 'text-layer' },
        pages: 'scanned',
        minTextChars: 40,
        stripImages: true,
        removeHeaderFooter: true,
        registry: registry(),
        cache: new CacheStore(null),
        reporter: new Reporter(),
      })
      expect(res.pageCount).toBe(pages)
      expect(res.pages.every((p) => p.source === source)).toBe(true)
    }
  })
})

describe('heading normalisation', () => {
  const md = [
    '<!-- page 1 -->',
    '',
    '# Kitap',
    '',
    '# 1. Giriş',
    '',
    'metin',
    '',
    '```',
    '# not a heading',
    '```',
    '',
    '<!-- page 2 -->',
    '',
    '# 1.1 Tanım',
    '',
    '## Şekil 1.1 Böbrek',
    '',
    '# Özet',
  ].join('\n')

  it('finds headings outside code fences with their pages', () => {
    const hs = findHeadings(md)
    expect(hs.map((h) => [h.text, h.page])).toEqual([
      ['Kitap', 1],
      ['1. Giriş', 1],
      ['1.1 Tanım', 2],
      ['Şekil 1.1 Böbrek', 2],
      ['Özet', 2],
    ])
  })

  it('applies corrections by id and caches them', async () => {
    const llm = new FakeLLM((req) => {
      if (req.system?.includes('analyse the structure')) {
        return JSON.stringify({
          documentType: 'textbook',
          mainSections: ['1. Giriş'],
          recurringBlocks: ['Özet'],
          notHeadings: ['Şekil'],
          notes: '',
        })
      }
      return JSON.stringify({
        corrections: [
          { id: 2, level: 2 },
          { id: 3, level: 0 },
          { id: 4, level: 3 },
          { id: 99, level: 1 },
        ],
      })
    })
    const cache = await tmpCache()
    const res = await fixHeadings(md, { llm, cache, reporter: new Reporter() })
    expect(res.corrections).toBe(3)
    expect(res.documentType).toBe('textbook')
    expect(res.markdown).toContain('## 1.1 Tanım')
    expect(res.markdown).toContain('\nŞekil 1.1 Böbrek\n')
    expect(res.markdown).toContain('### Özet')
    expect(res.markdown).toContain('# not a heading')
    const again = await fixHeadings(md, { llm, cache, reporter: new Reporter() })
    expect(again.cached).toBe(true)
    expect(again.markdown).toBe(res.markdown)
    expect(llm.requests).toHaveLength(2)
  })

  it('skips gracefully on bad output but rethrows configuration errors', async () => {
    const bad = new FakeLLM(() => 'nonsense')
    const reporter = new Reporter()
    const res = await fixHeadings(md, { llm: bad, cache: new CacheStore(null), reporter })
    expect(res.skipped).toBe('structure discovery failed')
    expect(res.markdown).toBe(md)
    expect(reporter.warnings).toHaveLength(1)
    const broken = new FakeLLM(() => {
      throw new RagChunkerError('MODEL_NOT_FOUND', 'gone')
    })
    await expect(
      fixHeadings(md, { llm: broken, cache: new CacheStore(null), reporter }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('harmonises numbered headings of the same depth', () => {
    const doc = [
      '# Kitap',
      '',
      '## 1. Giriş',
      '',
      '## 2. Yöntem',
      '',
      '# 3. Bulgular',
      '',
      '#### 3.1 Alt',
      '',
      '## 3.2 Diğer',
      '',
      '### 3.3 Son',
    ].join('\n')
    const hs = findHeadings(doc)
    const out = applyHeadingLevels(doc, harmonizeNumberedHeadings(hs, new Map()), hs)
    expect(out).toContain('\n## 3. Bulgular')
    expect(out).toContain('\n### 3.1 Alt')
    expect(out).toContain('\n### 3.2 Diğer')
    expect(out).toContain('# Kitap')
  })

  it('applyHeadingLevels leaves unknown lines alone', () => {
    const hs = findHeadings('# A\n\ntext\n\n## B')
    expect(applyHeadingLevels('# A\n\ntext\n\n## B', new Map([[4, 3]]), hs)).toBe('# A\n\ntext\n\n### B')
  })
})

describe('context enrichment', () => {
  const sentences = (n: number, w: string) =>
    Array.from({ length: n }, (_, i) => `${w} konusu ${i}. cümlede ayrıntılı olarak anlatılır.`).join(' ')
  const md = [
    '# Kitap',
    '',
    '## Sodyum',
    '',
    sentences(40, 'Sodyum'),
    '',
    '## Potasyum',
    '',
    sentences(40, 'Potasyum'),
    '',
    '## Kısa',
    '',
    '...',
  ].join('\n')
  const doc = chunkMarkdownDocument(md, { maxTokens: 160, minTokens: 0 })

  it('summarises every eligible chunk with the full document as a cached prefix', async () => {
    const llm = new FakeLLM((req) =>
      JSON.stringify({ items: chunkIds(req).map((id) => ({ id, context: `Bağlam ${id}.` })) }),
    )
    const res = await enrichChunks(
      { markdown: md, ...doc },
      { llm, strategy: 'auto', batchSize: 4, cache: await tmpCache(), reporter: new Reporter() },
    )
    expect(res.strategy).toBe('full')
    expect(res.skipped).toBe(1)
    expect(res.enriched).toBe(doc.chunks.length - 1)
    doc.chunks.forEach((c, i) => {
      expect(res.summaries[i]).toBe(isLowQuality(c.text) ? '' : `Bağlam ${i}.`)
    })
    expect(llm.requests.every((r) => r.prefix?.includes('<document>'))).toBe(true)
    // Batches are full runs of consecutive chunks, even across sections.
    const eligible = doc.chunks.filter((c) => !isLowQuality(c.text)).length
    expect(llm.requests).toHaveLength(Math.ceil(eligible / 4))
    expect(llm.requests.some((r) => new Set(chunkIds(r).map((id) => doc.chunks[id]?.group)).size > 1)).toBe(
      true,
    )
  })

  it('retries missing ids one by one and splits failing batches', async () => {
    const llm = new FakeLLM((req) => {
      const ids = chunkIds(req)
      if (ids.length > 2) return 'broken json'
      return JSON.stringify({
        items: ids.slice(0, Math.max(1, ids.length - 1)).map((id) => ({ id, context: `C${id}` })),
      })
    })
    const res = await enrichChunks(
      { markdown: md, ...doc },
      { llm, strategy: 'full', batchSize: 4, cache: new CacheStore(null), reporter: new Reporter() },
    )
    expect(res.failed).toBe(0)
    expect(res.enriched).toBe(doc.chunks.length - 1)
  })

  it('uses section summaries when the document does not fit the model', async () => {
    const llm = new FakeLLM(
      (req) => {
        if (req.system?.startsWith('Summarise the given part')) {
          const first = req.parts[0]
          const title = first?.type === 'text' ? first.text.split('\n')[0] : ''
          return JSON.stringify({ summary: `${title} özeti.` })
        }
        if (req.system?.startsWith('You get the sections')) return JSON.stringify({ summary: 'Belge özeti.' })
        return JSON.stringify({ items: chunkIds(req).map((id) => ({ id, context: `H${id}` })) })
      },
      { contextWindow: 3000 },
    )
    const reporter = new Reporter()
    const res = await enrichChunks(
      { markdown: md, ...doc },
      { llm, strategy: 'full', batchSize: 2, cache: new CacheStore(null), reporter },
    )
    expect(res.strategy).toBe('hierarchical')
    expect(reporter.warnings[0]).toMatch(/does not fit/)
    const chunkReqs = llm.requests.filter((r) => r.system?.startsWith('You write contextual'))
    expect(chunkReqs.every((r) => r.prefix?.includes('Belge özeti.'))).toBe(true)
    // Every section in a batch brings its own summary.
    for (const r of chunkReqs) {
      const text = JSON.stringify(r.parts)
      for (const id of chunkIds(r)) {
        const section = doc.sections.find((s) => s.group === doc.chunks[id]?.group)
        expect(text).toContain(`${section?.path.join(' > ')} özeti.`)
      }
    }
    expect(res.enriched).toBe(doc.chunks.length - 1)
  })

  it('summarises only sections that span several chunks', async () => {
    const short = [
      '# Kanun',
      '',
      ...[1, 2, 3].flatMap((n) => [
        `## Madde ${n}`,
        '',
        `Madde ${n} metni kısa bir hükümdür ve tek parçaya sığar.`,
        '',
      ]),
    ].join('\n')
    const shortDoc = chunkMarkdownDocument(short, { maxTokens: 160, minTokens: 0 })
    const llm = new FakeLLM(
      (req) => {
        if (req.system?.startsWith('Summarise the given part')) return JSON.stringify({ summary: 'Özet.' })
        if (req.system?.startsWith('You get the sections')) return JSON.stringify({ summary: 'Belge özeti.' })
        return JSON.stringify({ items: chunkIds(req).map((id) => ({ id, context: `K${id}` })) })
      },
      { contextWindow: 3000 },
    )
    const res = await enrichChunks(
      { markdown: short, ...shortDoc },
      { llm, strategy: 'hierarchical', batchSize: 10, cache: new CacheStore(null), reporter: new Reporter() },
    )
    expect(llm.requests.filter((r) => r.system?.startsWith('Summarise the given part'))).toHaveLength(0)
    const docReq = llm.requests.find((r) => r.system?.startsWith('You get the sections'))
    expect(JSON.stringify(docReq?.parts)).toContain('Kanun > Madde 2')
    expect(res.enriched).toBe(shortDoc.chunks.length)
  })

  it('stops on configuration errors', async () => {
    const llm = new FakeLLM(() => {
      throw new RagChunkerError('MISSING_API_KEY', 'no key')
    })
    await expect(
      enrichChunks(
        { markdown: md, ...doc },
        { llm, strategy: 'full', batchSize: 4, cache: new CacheStore(null), reporter: new Reporter() },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_API_KEY' })
  })

  it('classifies low-quality chunks', () => {
    expect(isLowQuality('…')).toBe(true)
    expect(isLowQuality('| | | | | — | — | — | | | · · · | | | | | | |')).toBe(true)
    expect(isLowQuality('BoolQ PIQA SIQA 7B 75.0 80.6 48.5 76.4 68.3 70.2 42.6 51.4 21.3 26.8')).toBe(false)
    expect(
      isLowQuality('Hiponatremi serum sodyumunun düşük olmasıdır ve tedavisi nedene göre değişir.'),
    ).toBe(false)
  })
})

describe('embedTexts', () => {
  it('batches, caches, keeps order and truncates long inputs', async () => {
    const embedder = new FakeEmbedder(50, 2)
    const cache = await tmpCache()
    const reporter = new Reporter()
    const texts = ['bir', 'iki', 'üç', 'kelime '.repeat(200)]
    const res = await embedTexts(texts, { embedder, kind: 'document', cache, reporter })
    expect(res.vectors.map((v) => v[1])).toEqual([0, 0, 0, 0])
    expect(res.vectors[0]?.[0]).toBe(3)
    expect(res.truncated).toBe(1)
    expect(embedder.calls).toHaveLength(2)
    expect(reporter.warnings[0]).toMatch(/truncated/)
    const again = await embedTexts(texts, { embedder, kind: 'document', cache })
    expect(again.cached).toBe(4)
    expect(embedder.calls).toHaveLength(2)
    const q = await embedTexts(['bir'], { embedder, kind: 'query', cache })
    expect(q.vectors[0]?.[1]).toBe(1)
  })
})

it('fixtures exist', async () => {
  expect((await readFile(fixture('turkish.pdf'))).length).toBeGreaterThan(1000)
})
