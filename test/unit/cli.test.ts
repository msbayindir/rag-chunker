import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheCommand } from '../../src/cli/commands/cache.js'
import { runChecks } from '../../src/cli/commands/doctor.js'
import { configFor, initCommand } from '../../src/cli/commands/init.js'
import { expandInputs, flagsToConfig, outputDirs, runProcess } from '../../src/cli/commands/process.js'
import { startInspectServer } from '../../src/cli/inspect/server.js'
import { resolveConfig } from '../../src/config/load.js'
import { detectLocalModels, localPreset, recommendedGemma } from '../../src/config/presets.js'
import { processDocument } from '../../src/index.js'
import { fixture } from '../fixtures/generate.js'
import { stripAnsi } from '../helpers/ansi.js'
import { json, MockServer } from '../helpers/mock-server.js'

let stdout = ''
let stderr = ''
beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += stripAnsi(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += stripAnsi(String(chunk))
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const server = new MockServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

function fakeOllamaModels(models: Array<{ name: string; caps: string[] }>) {
  server.reset()
  server.on('GET', '/api/tags', (_r, res) =>
    json(res, 200, { models: models.map((m) => ({ name: m.name, model: m.name })) }),
  )
  server.on('POST', '/api/show', (r, res) => {
    const m = models.find((x) => x.name === (r.body as any).model)
    if (!m) return json(res, 404, { error: 'not found' })
    json(res, 200, {
      model_info: { 'x.context_length': m.caps.includes('embedding') ? 2048 : 131072 },
      capabilities: m.caps,
    })
  })
}

describe('process command helpers', () => {
  it('maps flags to config overrides', () => {
    expect(
      flagsToConfig({
        ocr: 'mistral',
        context: 'gemini/x',
        maxTokens: 300,
        overlap: 20,
        cache: false,
        contextStrategy: 'full',
      }),
    ).toEqual({
      ocr: { engine: 'mistral', pages: undefined },
      models: { vision: undefined, structure: undefined, context: 'gemini/x', embedding: undefined },
      chunk: { maxTokens: 300, minTokens: undefined, overlapTokens: 20 },
      context: { strategy: 'full' },
      cache: { enabled: false },
    })
    expect(flagsToConfig({})).toEqual({})
    expect(flagsToConfig({ layout: true })).toEqual({ layout: { engine: 'pp-doclayout-v3' } })
    expect(flagsToConfig({ layout: false })).toEqual({ layout: { engine: 'off' } })
  })

  it('expands folders recursively and names output folders uniquely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-in-'))
    await mkdir(join(dir, 'a'))
    await writeFile(join(dir, 'a', 'not.md'), '# x')
    await writeFile(join(dir, 'not.md'), '# y')
    await writeFile(join(dir, 'skip.exe'), 'x')
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, '.hidden', 'h.md'), '# h')
    const files = await expandInputs([dir])
    expect(files.map((f) => f.slice(dir.length))).toEqual(['/a/not.md', '/not.md'])
    const dirs = outputDirs(files, '/tmp/out')
    expect(dirs).toEqual(['/tmp/out/not', '/tmp/out/not-2'])
    expect(outputDirs([files[0] as string], '/tmp/single')).toEqual(['/tmp/single'])
    await expect(expandInputs([join(dir, 'nope')])).rejects.toThrow(/Not found/)
    await mkdir(join(dir, 'empty'))
    await writeFile(join(dir, 'empty', 'data.bin'), 'x')
    await expect(expandInputs([join(dir, 'empty')])).rejects.toThrow(/No supported/)
  })
})

describe('rag-chunker process', () => {
  it('writes output and prints a JSON summary', async () => {
    const out = await mkdtemp(join(tmpdir(), 'rc-cli-'))
    const code = await runProcess([fixture('sample.md')], { output: out, json: true, cache: false })
    expect(code).toBe(0)
    const summary = JSON.parse(stdout)
    expect(summary[0]).toMatchObject({ output: out })
    expect(summary[0].chunks).toBeGreaterThan(0)
    expect(existsSync(join(out, 'manifest.json'))).toBe(true)
  })

  it('prints a human summary with warnings', async () => {
    const out = await mkdtemp(join(tmpdir(), 'rc-cli-'))
    expect(await runProcess([fixture('turkish.pdf')], { output: out, cache: false })).toBe(0)
    expect(stderr).toContain('rag-chunker')
    expect(stderr).toMatch(/\d+ chunks/)
    expect(stderr).toContain('warning')
  })

  it('reports a dry run as JSON without writing anything', async () => {
    const out = await mkdtemp(join(tmpdir(), 'rc-cli-'))
    expect(
      await runProcess([fixture('turkish.pdf')], {
        output: out,
        json: true,
        dryRun: true,
        context: 'ollama/x',
      }),
    ).toBe(0)
    const plan = JSON.parse(stdout)
    expect(plan[0]).toMatchObject({ pages: 4, context: { model: 'ollama/x' } })
    expect(existsSync(join(out, 'manifest.json'))).toBe(false)
  })

  it('returns exit code 1 with a hint for bad input', async () => {
    expect(await runProcess(['/definitely/missing.pdf'], {})).toBe(1)
    expect(stderr).toContain('Not found')
    stderr = ''
    expect(await runProcess([fixture('sample.md')], { context: 'not-a-ref', cache: false })).toBe(1)
    expect(stderr).toContain('provider/model')
  })
})

describe('local preset', () => {
  it('picks the best installed Gemma 4 for the RAM and a local embedding model', async () => {
    fakeOllamaModels([
      { name: 'gemma4:26b-a4b-it-qat', caps: ['completion', 'vision'] },
      { name: 'gemma4:e4b-it-qat', caps: ['completion', 'vision'] },
      { name: 'embeddinggemma:latest', caps: ['embedding'] },
    ])
    const env = { OLLAMA_HOST: server.url }
    expect(await detectLocalModels(env, {}, 16)).toMatchObject({
      llm: 'gemma4:e4b-it-qat',
      embedding: 'embeddinggemma:latest',
    })
    expect((await detectLocalModels(env, {}, 64)).llm).toBe('gemma4:26b-a4b-it-qat')
    const preset = await localPreset(env)
    expect(preset.models?.embedding).toBe('ollama/embeddinggemma:latest')
    expect(preset.ocr?.engine).toBe(preset.models?.vision)
  })

  it('explains how to install a model when none is present', async () => {
    fakeOllamaModels([{ name: 'llama3:8b', caps: ['completion'] }])
    await expect(localPreset({ OLLAMA_HOST: server.url })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    expect(recommendedGemma(16)).toBe('gemma4:e4b-it-qat')
    expect(recommendedGemma(8)).toBe('gemma4:e2b-it-qat')
  })
})

describe('doctor', () => {
  it('reports keys, Ollama models and configured model capabilities', async () => {
    fakeOllamaModels([
      { name: 'gemma4:e4b-it-qat', caps: ['completion', 'vision'] },
      { name: 'embeddinggemma', caps: ['embedding'] },
    ])
    const cacheDir = await mkdtemp(join(tmpdir(), 'rc-doc-'))
    const config = resolveConfig({
      models: {
        vision: 'ollama/gemma4:e4b-it-qat',
        embedding: 'ollama/embeddinggemma',
        context: 'openai/gpt-x',
      },
      cache: { dir: cacheDir },
    })
    const checks = await runChecks(config, { OLLAMA_HOST: server.url, GEMINI_API_KEY: 'AIzaSyExample12345' })
    const by = (label: string) => checks.find((c) => c.label === label)
    expect(by('Node.js')?.status).toBe('ok')
    expect(by('Cache')?.status).toBe('ok')
    expect(by('gemini key')?.detail).toContain('AIza…45')
    expect(by('Ollama')?.status).toBe('ok')
    expect(by('vision')?.status).toBe('ok')
    expect(by('embedding')?.detail).toContain('max input')
    expect(by('context')?.status).toBe('fail')
    expect(by('context')?.hint).toContain('OPENAI_API_KEY')
  })

  it('handles an unreachable Ollama', async () => {
    const checks = await runChecks(resolveConfig({ cache: { enabled: false } }), {
      OLLAMA_HOST: 'http://127.0.0.1:9',
    })
    expect(checks.find((c) => c.label === 'Ollama')?.detail).toContain('not reachable')
  })
})

describe('init', () => {
  it('builds sensible configs for every setup', () => {
    expect(configFor('local', { gemma: 'gemma4:e4b-it-qat' }).models?.context).toBe(
      'ollama/gemma4:e4b-it-qat',
    )
    expect(configFor('text')).toEqual({ ocr: { engine: 'text-layer' } })
    expect(configFor('gemini', { mistral: true }).ocr).toEqual({ engine: 'mistral' })
    for (const setup of ['local', 'gemini', 'anthropic', 'openai', 'openrouter', 'text'] as const) {
      expect(() => resolveConfig(configFor(setup))).not.toThrow()
    }
  })

  it('writes rag-chunker.config.json with --yes and refuses to overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-init-'))
    const cwd = process.cwd()
    const host = process.env.OLLAMA_HOST
    process.env.OLLAMA_HOST = 'http://127.0.0.1:9'
    process.chdir(dir)
    try {
      await initCommand().parseAsync(['node', 'init', '--yes'])
      const written = JSON.parse(await readFile(join(dir, 'rag-chunker.config.json'), 'utf8'))
      expect(written.$schema).toContain('config.schema.json')
      expect(() => resolveConfig(written)).not.toThrow()
      await initCommand().parseAsync(['node', 'init', '--yes'])
      expect(process.exitCode).toBe(1)
      expect(stderr).toContain('already exists')
    } finally {
      process.chdir(cwd)
      if (host === undefined) delete process.env.OLLAMA_HOST
      else process.env.OLLAMA_HOST = host
    }
  })
})

describe('inspect server and cache command', () => {
  it('serves the UI, data, local marked and the PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-ui-'))
    await (await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env: {} })).save(
      dir,
    )
    const srv = await startInspectServer({ dir, pdf: fixture('turkish.pdf') })
    try {
      const html = await (await fetch(srv.url)).text()
      expect(html).toContain('rag-chunker inspector')
      const data = await (await fetch(`${srv.url}/api/data`)).json()
      expect(data.hasPdf).toBe(true)
      expect(data.chunks.length).toBeGreaterThan(0)
      expect((await fetch(`${srv.url}/static/marked.js`)).status).toBe(200)
      expect((await fetch(`${srv.url}/static/app.js`)).headers.get('content-type')).toContain('javascript')
      expect((await fetch(`${srv.url}/api/pdf`)).headers.get('content-type')).toBe('application/pdf')
      const png = new Uint8Array(await (await fetch(`${srv.url}/api/page/1.png`)).arrayBuffer())
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect((await fetch(`${srv.url}/../../etc/passwd`)).status).toBe(404)
    } finally {
      await srv.close()
    }
  })

  it('shows and clears the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-cachecmd-'))
    await processDocument(fixture('sample.md'), { cache: { dir }, models: {} }, { env: {} })
    await cacheCommand().parseAsync(['node', 'cache', 'info', '--dir', dir])
    expect(stderr).toContain('entries')
    await cacheCommand().parseAsync(['node', 'cache', 'clear', '--dir', dir])
    expect(stderr).toMatch(/Removed \d+/)
  })
})
