import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, loadConfigFile, mergeConfigs, readDotEnv, resolveConfig } from '../../src/config/load.js'
import { normalizeOllamaHost, resolveProvider } from '../../src/config/providers.js'
import { RagChunkerError } from '../../src/errors.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rag-chunker-config-'))
}

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    const cfg = resolveConfig({})
    expect(cfg.ocr.engine).toBe('auto')
    expect(cfg.chunk).toMatchObject({ maxTokens: 512, minTokens: 64, overlapTokens: 0, tokenizer: 'o200k' })
    expect(cfg.models).toEqual({})
    expect(cfg.cache.enabled).toBe(true)
    expect(cfg.context.strategy).toBe('auto')
  })

  it('keeps nested defaults when only part of a section is given', () => {
    const cfg = resolveConfig({ chunk: { maxTokens: 800 } })
    expect(cfg.chunk.maxTokens).toBe(800)
    expect(cfg.chunk.minTokens).toBe(64)
    expect(cfg.chunk.preserveTables).toBe(true)
  })

  it('rejects malformed model references with a readable message', () => {
    try {
      resolveConfig({ models: { context: 'gemma4' } })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(RagChunkerError)
      expect((err as RagChunkerError).code).toBe('CONFIG_INVALID')
      expect((err as Error).message).toContain('provider/model')
    }
  })

  it('rejects unknown keys and inconsistent chunk sizes', () => {
    expect(() => resolveConfig({ chunk: { maxTokens: 100, minTokens: 200 } })).toThrow(/minTokens/)
    expect(() => resolveConfig({ chunk: { maxTokens: 100, overlapTokens: 80 } })).toThrow(/overlapTokens/)
    expect(() => resolveConfig({ bogus: true } as never)).toThrow(RagChunkerError)
  })

  it('accepts provider/model references with slashes in the model name', () => {
    const cfg = resolveConfig({ models: { context: 'openrouter/anthropic/claude-haiku-5-5' } })
    expect(cfg.models.context).toBe('openrouter/anthropic/claude-haiku-5-5')
  })

  it('validates ocr.engine', () => {
    expect(resolveConfig({ ocr: { engine: 'mistral' } }).ocr.engine).toBe('mistral')
    expect(resolveConfig({ ocr: { engine: 'ollama/gemma4:e4b-it-qat' } }).ocr.engine).toBe(
      'ollama/gemma4:e4b-it-qat',
    )
    expect(() => resolveConfig({ ocr: { engine: 'tesseract' } })).toThrow(/ocr.engine/)
  })
})

describe('mergeConfigs', () => {
  it('deep-merges and lets later values win without undefined overwriting', () => {
    const merged = mergeConfigs(
      { chunk: { maxTokens: 300, minTokens: 20 }, models: { context: 'ollama/a' } },
      { chunk: { maxTokens: 400, minTokens: undefined }, models: { embedding: 'ollama/b' } },
    )
    expect(merged).toEqual({
      chunk: { maxTokens: 400, minTokens: 20 },
      models: { context: 'ollama/a', embedding: 'ollama/b' },
    })
  })
})

describe('config files', () => {
  it('loads rag-chunker.config.json from cwd and applies overrides on top', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, 'rag-chunker.config.json'),
      JSON.stringify({ chunk: { maxTokens: 300 }, models: { context: 'ollama/gemma4:e4b-it-qat' } }),
    )
    const { config, file } = await loadConfig({ cwd: dir, overrides: { chunk: { maxTokens: 700 } } })
    expect(file).toBe(join(dir, 'rag-chunker.config.json'))
    expect(config.chunk.maxTokens).toBe(700)
    expect(config.models.context).toBe('ollama/gemma4:e4b-it-qat')
  })

  it('loads an .mjs config with defineConfig', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'rag-chunker.config.mjs'), 'export default { chunk: { minTokens: 10 } }\n')
    const { config } = await loadConfig({ cwd: dir })
    expect(config.chunk.minTokens).toBe(10)
  })

  it('refuses API keys inside config files', async () => {
    const dir = await tempDir()
    const path = join(dir, 'rag-chunker.config.json')
    await writeFile(path, JSON.stringify({ providers: { openai: { apiKey: 'sk-xxx' } } }))
    await expect(loadConfigFile(path)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('reports invalid JSON and missing files clearly', async () => {
    const dir = await tempDir()
    const path = join(dir, 'rag-chunker.config.json')
    await writeFile(path, '{ nope')
    await expect(loadConfigFile(path)).rejects.toThrow(/not valid JSON/)
    await expect(loadConfigFile(join(dir, 'missing.json'))).rejects.toThrow(/not found/)
  })

  it('reads .env files without touching process.env', async () => {
    const dir = await tempDir()
    const path = join(dir, '.env')
    await writeFile(
      path,
      ['# comment', 'A=1', 'export B="iki üç"', "C='x'", 'D=val # trailing', ''].join('\n'),
    )
    expect(await readDotEnv(path)).toEqual({ A: '1', B: 'iki üç', C: 'x', D: 'val' })
    expect(process.env.B).toBeUndefined()
    expect(await readDotEnv(join(dir, 'none'))).toEqual({})
  })
})

describe('resolveProvider', () => {
  it('resolves built-in providers from the environment', () => {
    const p = resolveProvider('gemini', undefined, { GOOGLE_API_KEY: 'g-key' })
    expect(p).toMatchObject({ type: 'gemini', apiKey: 'g-key', local: false })
    const o = resolveProvider('openrouter', undefined, { OPENROUTER_API_KEY: ' k ' })
    expect(o).toMatchObject({ type: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'k' })
  })

  it('uses OLLAMA_HOST and marks ollama as local with concurrency 1', () => {
    const p = resolveProvider('ollama', undefined, { OLLAMA_HOST: '0.0.0.0:11500' })
    expect(p).toMatchObject({
      baseURL: 'http://127.0.0.1:11500',
      local: true,
      concurrency: 1,
      maxContext: 32768,
    })
  })

  it('requires a type for custom provider names and honours overrides', () => {
    expect(resolveProvider('mylab', undefined, {})).toBeUndefined()
    const p = resolveProvider(
      'mylab',
      {
        type: 'openai-compatible',
        baseURL: 'http://localhost:8000/v1',
        apiKeyEnv: 'LAB_KEY',
        concurrency: 3,
      },
      { LAB_KEY: 'secret' },
    )
    expect(p).toMatchObject({ type: 'openai-compatible', apiKey: 'secret', local: true, concurrency: 3 })
  })

  it('normalises OLLAMA_HOST values', () => {
    expect(normalizeOllamaHost('localhost')).toBe('http://localhost:11434')
    expect(normalizeOllamaHost('https://ollama.example.com')).toBe('https://ollama.example.com')
    expect(normalizeOllamaHost('')).toBeUndefined()
  })
})
