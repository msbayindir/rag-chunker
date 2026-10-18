import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { evalCommand } from '../../src/cli/commands/eval.js'
import { exportCommand } from '../../src/cli/commands/export.js'
import { inspectCommand } from '../../src/cli/commands/inspect.js'
import { processDocument } from '../../src/index.js'
import { fixture } from '../fixtures/generate.js'
import { stripAnsi } from '../helpers/ansi.js'
import { json, MockServer } from '../helpers/mock-server.js'

let stdout = ''
let stderr = ''
const server = new MockServer()
const savedEnv = { ...process.env }

beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    stdout += stripAnsi(String(c))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    stderr += stripAnsi(String(c))
    return true
  })
  server.reset()
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  process.env = { ...savedEnv }
})

async function outputWithEmbeddings(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rc-cmd-'))
  const res = await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env: {} })
  res.chunks.forEach((c, i) => {
    c.embedding = [i + 1, 0.5, 0.25]
  })
  await res.save(dir)
  return dir
}

describe('inspect command', () => {
  it('prints a summary of an output folder', async () => {
    const dir = await outputWithEmbeddings()
    await inspectCommand().parseAsync(['node', 'inspect', dir])
    expect(stderr).toContain('turkish.pdf')
    expect(stderr).toMatch(/Chunks\s+\d+/)
    expect(stderr).toContain('First chunk')
  })

  it('fails clearly for a folder without output', async () => {
    await inspectCommand().parseAsync(['node', 'inspect', await mkdtemp(join(tmpdir(), 'rc-empty-'))])
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('not a rag-chunker output directory')
  })
})

describe('export command', () => {
  it('exports to LanceDB', async () => {
    const dir = await outputWithEmbeddings()
    const db = join(await mkdtemp(join(tmpdir(), 'rc-lance-')), 'db')
    await exportCommand().parseAsync(['node', 'export', dir, '--to', 'lancedb', '--url', db])
    expect(process.exitCode).toBeUndefined()
    expect(stderr).toMatch(/turkish\.pdf → .*rag_chunks/)
    expect(existsSync(db)).toBe(true)
  })

  it('needs embeddings or --embedding, and a URL for pgvector', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-noemb-'))
    await (await processDocument(fixture('sample.md'), { cache: { enabled: false } }, { env: {} })).save(dir)
    await exportCommand().parseAsync(['node', 'export', dir, '--to', 'lancedb', '--url', join(dir, 'db')])
    expect(stderr).toContain('no embeddings')
    stderr = ''
    process.env.DATABASE_URL = ''
    await exportCommand().parseAsync(['node', 'export', dir, '--to', 'pgvector'])
    expect(stderr).toContain('--url or DATABASE_URL')
  })

  it('embeds during export with --embedding', async () => {
    server.on('POST', '/api/show', (_r, res) =>
      json(res, 200, { model_info: { 'g.context_length': 2048 }, capabilities: ['embedding'] }),
    )
    server.on('POST', '/api/embed', (r, res) =>
      json(res, 200, { embeddings: (r.body as any).input.map(() => [0.1, 0.2]) }),
    )
    process.env.OLLAMA_HOST = server.url
    const dir = await mkdtemp(join(tmpdir(), 'rc-embexp-'))
    await (await processDocument(fixture('sample.md'), { cache: { enabled: false } }, { env: {} })).save(dir)
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      await writeFile(join(dir, 'rag-chunker.config.json'), JSON.stringify({ cache: { enabled: false } }))
      await exportCommand().parseAsync([
        'node',
        'export',
        dir,
        '--to',
        'lancedb',
        '--url',
        join(dir, 'db'),
        '--embedding',
        'ollama/embeddinggemma',
      ])
    } finally {
      process.chdir(cwd)
    }
    expect(stderr).toMatch(/2 dims/)
  })
})

describe('eval command', () => {
  it('generates questions with a model, scores the folder and writes eval.json', async () => {
    server.on('POST', '/api/show', (r, res) => {
      const model = (r.body as any).model
      json(res, 200, {
        model_info: { 'g.context_length': model.includes('embed') ? 2048 : 32768 },
        capabilities: model.includes('embed') ? ['embedding'] : ['completion'],
      })
    })
    server.on('POST', '/api/chat', (r, res) => {
      const passage = (r.body as any).messages.at(-1).content as string
      const sentence = (passage.match(/[^.]{20,}\./) ?? [passage.slice(0, 80)])[0]?.trim()
      json(res, 200, {
        message: {
          role: 'assistant',
          content: JSON.stringify({ question: `Bu nedir: ${sentence?.slice(0, 40)}?`, evidence: sentence }),
        },
        done: true,
      })
    })
    process.env.OLLAMA_HOST = server.url
    const dir = await mkdtemp(join(tmpdir(), 'rc-eval-'))
    await (await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env: {} })).save(
      dir,
    )
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      await writeFile(join(dir, 'rag-chunker.config.json'), JSON.stringify({ cache: { enabled: false } }))
      await evalCommand().parseAsync([
        'node',
        'eval',
        dir,
        '--model',
        'ollama/gemma4:e4b-it-qat',
        '--questions',
        '3',
        '--json',
      ])
    } finally {
      process.chdir(cwd)
    }
    expect(process.exitCode).toBeUndefined()
    const reports = JSON.parse(stdout)
    expect(reports[0].metrics[0]).toMatchObject({ mode: 'bm25' })
    expect(reports[0].metrics[0].questions).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'eval.json'))).toBe(true)
    const questions = JSON.parse(await readFile(join(dir, 'eval-questions.json'), 'utf8'))
    expect(questions.questions.length).toBe(reports[0].metrics[0].questions)

    // Reuse the question set: no model calls needed.
    stdout = ''
    server.reset()
    process.chdir(dir)
    try {
      await evalCommand().parseAsync([
        'node',
        'eval',
        dir,
        '--questions-file',
        join(dir, 'eval-questions.json'),
        '--json',
      ])
    } finally {
      process.chdir(cwd)
    }
    expect(JSON.parse(stdout)[0].metrics[0].questions).toBe(questions.questions.length)
    expect(server.requests).toHaveLength(0)
  })

  it('asks for a model when none is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-eval2-'))
    await (await processDocument(fixture('sample.md'), { cache: { enabled: false } }, { env: {} })).save(dir)
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      await evalCommand().parseAsync(['node', 'eval', dir])
    } finally {
      process.chdir(cwd)
    }
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('--model')
  })
})
