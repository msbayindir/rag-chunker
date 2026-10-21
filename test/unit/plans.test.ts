import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODELS, type ModelId } from '../../src/local/models.js'
import { OCR_DET_MODEL, OCR_DICT, OCR_REC_MODEL } from '../../src/local/ocr.js'
import { hasOnnxRuntime } from '../../src/local/runtime.js'
import { createContext, processDocument, resolveOcrEngine } from '../../src/pipeline/process.js'
import { fixture } from '../fixtures/generate.js'

/** Fakes a downloaded model: presence is checked by file size, so a sparse file will do. */
async function fakeModel(dir: string, id: ModelId) {
  const fh = await open(join(dir, MODELS[id].file), 'w')
  await fh.truncate(MODELS[id].bytes)
  await fh.close()
}

describe('OCR engine plan', () => {
  const previous = process.env.RAG_CHUNKER_MODELS_DIR
  afterEach(() => {
    if (previous === undefined) delete process.env.RAG_CHUNKER_MODELS_DIR
    else process.env.RAG_CHUNKER_MODELS_DIR = previous
  })

  it('keeps local OCR under "auto" with the mobile detector when the profile\'s server detector is missing', async () => {
    if (!(await hasOnnxRuntime())) return
    const dir = await mkdtemp(join(tmpdir(), 'rc-models-'))
    process.env.RAG_CHUNKER_MODELS_DIR = dir
    try {
      // Nothing downloaded: auto has no local OCR and no keys → text layer.
      const none = createContext({}, {})
      expect((await resolveOcrEngine(none)).engine).toEqual({ type: 'text-layer' })
      // A 4.0.0 installation: the mobile detector, the Latin recogniser and its dictionary.
      for (const id of [OCR_DET_MODEL, OCR_REC_MODEL, OCR_DICT]) await fakeModel(dir, id)
      const upgraded = await resolveOcrEngine(createContext({}, {}))
      expect(upgraded.engine).toEqual({ type: 'local' })
      expect(upgraded.detector).toBe('mobile')
      expect(upgraded.note).toContain('mobile text detector')
      // The basic profile asks for the mobile detector anyway: no note.
      const basic = await resolveOcrEngine(createContext({ local: { profile: 'basic' } }, {}))
      expect(basic.engine).toEqual({ type: 'local' })
      expect(basic.detector).toBeUndefined()
      expect(basic.note).toBeUndefined()
      // With the server detector on disk the full profile needs no fallback.
      await fakeModel(dir, 'pp-ocrv5-det-server')
      const full = await resolveOcrEngine(createContext({}, {}))
      expect(full.engine).toEqual({ type: 'local' })
      expect(full.detector).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses formulas.recognize "on" when layout analysis is off', async () => {
    await expect(
      processDocument(
        fixture('turkish.pdf'),
        {
          ocr: { engine: 'text-layer' },
          layout: { engine: 'off' },
          formulas: { recognize: 'on' },
          cache: { enabled: false },
        },
        { env: {} },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})
