import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/load.js'
import { readDocument } from '../../src/documents/input.js'
import { subsetPdf } from '../../src/documents/pdf.js'
import { processDocument } from '../../src/index.js'
import { mistralOcr } from '../../src/providers/mistral-ocr.js'
import { createEmbedder, createLLM, getProvider } from '../../src/providers/registry.js'
import { DOCX, PAGE1, SCANNED } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'
import { liveEnv } from './helpers.js'

const env = await liveEnv()
const hasMistral = !!env.MISTRAL_API_KEY

/** 'ok' when the key can run OCR, 'no-quota' when the plan allows 0 OCR requests. */
async function probeMistral(): Promise<'ok' | 'no-quota' | 'no-key'> {
  if (!hasMistral) return 'no-key'
  const provider = getProvider('mistral', { config: resolveConfig({}), env })
  const page = await subsetPdf(new Uint8Array(await readFile(fixture('turkish.pdf'))), [1])
  try {
    await mistralOcr({ provider, bytes: page, mime: 'application/pdf', kind: 'pdf' })
    return 'ok'
  } catch (err) {
    if ((err as { code?: string }).code === 'QUOTA_EXCEEDED') {
      console.warn(
        'Mistral: this key has no OCR quota (0 requests/minute); running the fallback checks instead.',
      )
      return 'no-quota'
    }
    throw err
  }
}
const mistral = await probeMistral()
const hasGemini = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY)

/** Override with GEMINI_TEST_* when Google renames models. */
const GEMINI_FAST = env.GEMINI_TEST_MODEL ?? 'gemini-3.5-flash-lite'
const GEMINI_VISION = env.GEMINI_TEST_VISION_MODEL ?? 'gemini-3.8-flash'
const GEMINI_EMBEDDING = env.GEMINI_TEST_EMBEDDING_MODEL ?? 'gemini-embedding-001'

describe.skipIf(mistral !== 'no-quota')('live: Mistral key without OCR quota', () => {
  it('fails fast with QUOTA_EXCEEDED when Mistral is chosen explicitly', async () => {
    const started = Date.now()
    await expect(
      processDocument(
        fixture('turkish.pdf'),
        { ocr: { engine: 'mistral' }, cache: { enabled: false } },
        { env },
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('falls back to the next OCR engine in auto mode', async () => {
    const res = await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env })
    expect(res.manifest.stages.ocr.engine).toBe('text-layer')
    expect(res.warnings.join(' ')).toContain('Mistral OCR is not usable')
    expect(res.chunks.length).toBeGreaterThan(0)
  })
})

describe.skipIf(mistral !== 'ok')('live: Mistral OCR', () => {
  it('OCRs every page of a PDF, including the scanned one', async () => {
    const res = await processDocument(
      fixture('turkish.pdf'),
      { ocr: { engine: 'mistral' }, cache: { enabled: false } },
      { env },
    )
    expect(res.manifest.stages.ocr.ocrPages).toBe(4)
    expect(res.markdown).toContain(PAGE1.heading.replace('1. ', ''))
    expect(res.markdown).toContain('Hipokalsemi')
    expect(res.markdown).not.toMatch(/!\[img-\d+/)
  })

  it('OCRs an image and a DOCX file', async () => {
    const provider = getProvider('mistral', { config: resolveConfig({}), env })
    const img = await readDocument(fixture('scan.png'))
    const imgRes = await mistralOcr({ provider, bytes: img.bytes, mime: img.mime, kind: 'image' })
    expect(imgRes.pages.map((p) => p.markdown).join('\n')).toContain('Hipokalsemi')
    const docx = await readDocument(fixture('sample.docx'))
    const docxRes = await mistralOcr({ provider, bytes: docx.bytes, mime: docx.mime, kind: 'docx' })
    expect(docxRes.pages.map((p) => p.markdown).join('\n')).toContain(DOCX.h2)
  })
})

describe.skipIf(!hasGemini)('live: Gemini', () => {
  const ctx = () => ({ config: resolveConfig({}), env })

  it('reports model capabilities', async () => {
    const caps = await createLLM(`gemini/${GEMINI_FAST}`, ctx()).capabilities()
    expect(caps.contextWindow).toBeGreaterThan(100_000)
  })

  it('reads a scanned page with vision', async () => {
    const llm = createLLM(`gemini/${GEMINI_VISION}`, ctx())
    const png = new Uint8Array(await readFile(fixture('scan.png')))
    const res = await llm.generate({
      system: 'Transcribe the image to markdown. Output only the markdown.',
      parts: [{ type: 'image', data: png, mimeType: 'image/png' }],
      maxOutputTokens: 2048,
    })
    expect(res.text).toContain(SCANNED.heading.split(' ')[1] as string)
  })

  it('embeds documents and queries', async () => {
    const e = createEmbedder(`gemini/${GEMINI_EMBEDDING}`, ctx())
    const out = await e.embed(['hiponatremi tedavisi', 'hiperkalemi'], 'document')
    expect(out.vectors).toHaveLength(2)
    expect(out.vectors[0]?.length).toBeGreaterThan(100)
    expect(await e.maxInputTokens()).toBeGreaterThan(500)
  })

  it('runs vision OCR, context and embeddings end to end', async () => {
    const res = await processDocument(
      fixture('turkish.pdf'),
      {
        models: {
          vision: `gemini/${GEMINI_VISION}`,
          context: `gemini/${GEMINI_FAST}`,
          embedding: `gemini/${GEMINI_EMBEDDING}`,
        },
        ocr: { engine: `gemini/${GEMINI_VISION}` },
        cache: { enabled: false },
      },
      { env },
    )
    expect(res.chunks.some((c) => c.rawContent.includes('Hipokalsemi'))).toBe(true)
    for (const c of res.chunks) {
      expect(c.contextSummary.length).toBeGreaterThan(20)
      expect(c.embedding.length).toBeGreaterThan(100)
    }
    expect(res.manifest.stages.context?.failed).toBe(0)
  })
})
