import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CacheStore } from '../../src/cache/store.js'
import { resolveConfig } from '../../src/config/load.js'
import { localPreset } from '../../src/config/presets.js'
import { evaluate, generateQuestions } from '../../src/eval/eval.js'
import { mergeConfigs, processDocument } from '../../src/index.js'
import { createEmbedder, createLLM } from '../../src/providers/registry.js'
import { generateJson } from '../../src/providers/structured.js'
import { SCANNED } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'
import { liveEnv, ollamaModels } from './helpers.js'

const env = await liveEnv()
const models = await ollamaModels(env)
const gemma = models?.find((m) => m.startsWith('gemma4'))
const embedding = models?.find((m) => m.startsWith('embeddinggemma'))

describe.skipIf(!gemma || !embedding)('live: Ollama (Gemma 4 + EmbeddingGemma)', () => {
  it('runs the whole pipeline locally on a Turkish PDF with a scanned page', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'rc-live-'))
    const config = mergeConfigs(await localPreset(env), {
      cache: { dir: cacheDir },
      chunk: { maxTokens: 400, minTokens: 30 },
    })
    const res = await processDocument(fixture('turkish.pdf'), config, { env })
    const scanned = res.chunks.find((c) => c.rawContent.includes('Hipokalsemi'))
    expect(scanned, 'the scanned page must be OCR’d').toBeDefined()
    expect(scanned?.ocrSource).toBe(`ollama/${gemma}`)
    expect(scanned?.rawContent).toContain('kalsiyum')
    // Numbered headings from the text layer and the vision model end up on the same level.
    expect(res.markdown).toMatch(/^## 3\. Hipokalsemi/m)
    for (const c of res.chunks) {
      expect(c.contextSummary.length, `context for chunk ${c.index}`).toBeGreaterThan(20)
      expect(c.embedding).toHaveLength(768)
    }
    expect(res.manifest.stages.context?.failed).toBe(0)
    expect(SCANNED.heading).toBe('3. Hipokalsemi')
  })

  it('works through Ollama’s OpenAI-compatible endpoint (structured output + embeddings)', async () => {
    const host = (env.OLLAMA_HOST ? env.OLLAMA_HOST.replace(/\/$/, '') : 'http://127.0.0.1:11434') + '/v1'
    const ctx = {
      config: resolveConfig({ providers: { local: { type: 'openai-compatible', baseURL: host } } }),
      env,
    }
    const llm = createLLM(`local/${gemma}`, ctx)
    const out = await generateJson(
      llm,
      {
        parts: [{ type: 'text', text: 'Türkiye’nin başkenti neresidir? Kısaca yanıtla.' }],
        maxOutputTokens: 512,
      },
      z.strictObject({ city: z.string() }),
      'capital',
    )
    expect(out.value.city.toLowerCase()).toContain('ankara')
    const emb = await createEmbedder(`local/${embedding}`, ctx).embed(
      ['hiponatremi', 'hiperkalemi'],
      'document',
    )
    expect(emb.vectors).toHaveLength(2)
    expect(emb.vectors[0]?.length).toBeGreaterThan(100)
  })

  it('generates evaluation questions and finds their chunks', async () => {
    const res = await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env })
    const ctx = { config: resolveConfig({}), env }
    const { set } = await generateQuestions(
      { markdown: res.markdown, documentId: res.manifest.source.documentId, source: 'turkish.pdf' },
      { llm: createLLM(`ollama/${gemma}`, ctx), count: 3, cache: new CacheStore(null) },
    )
    expect(set.questions.length).toBeGreaterThan(0)
    const report = evaluate(set, res.chunks, 'live')
    expect(report.metrics[0]?.hitAt10).toBeGreaterThan(0)
  })
})
