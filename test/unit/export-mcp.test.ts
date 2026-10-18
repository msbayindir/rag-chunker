import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { exportToLanceDb, exportToPgvector, exportToQdrant, pointId } from '../../src/export/export.js'
import { chunkMarkdown, processDocument } from '../../src/index.js'
import { createMcpServer } from '../../src/mcp/server.js'
import type { Chunk } from '../../src/types.js'
import { fixture } from '../fixtures/generate.js'
import { json, MockServer } from '../helpers/mock-server.js'

const md = [
  '# Rehber',
  '',
  '## Sodyum',
  '',
  'Sodyum dengesi hücre dışı sıvıyı belirler. '.repeat(3),
  '',
  '## Potasyum',
  '',
  'Potasyum hücre içi ana katyondur. '.repeat(3),
].join('\n')
const embedded = (chunks: Chunk[]): Chunk[] => chunks.map((c, i) => ({ ...c, embedding: [i + 1, 1, 0.5] }))

describe('pgvector export (real SQL through node-postgres → PGlite)', () => {
  let db: PGlite
  let socket: PGLiteSocketServer
  let client: pg.Client

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { vector } })
    socket = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' })
    await socket.start()
    const addr = socket.getServerConn()
    client = new pg.Client({ connectionString: `postgres://postgres@${addr}/postgres`, ssl: false })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
    await socket.stop()
    await db.close()
  })

  it('creates the table, upserts chunks and removes stale rows with replaceDocument', async () => {
    const chunks = embedded(chunkMarkdown(md, { minTokens: 0 }))
    const res = await exportToPgvector(client, chunks, { createIndex: true })
    expect(res).toMatchObject({
      target: 'pgvector',
      written: chunks.length,
      dimensions: 3,
      location: 'rag_chunks',
    })
    const rows = await client.query(
      'SELECT chunk_id, section_path, page_start, metadata FROM rag_chunks ORDER BY chunk_index',
    )
    expect(rows.rows).toHaveLength(chunks.length)
    expect(rows.rows[0].section_path).toEqual(chunks[0]?.sectionPath)
    expect(rows.rows[0].metadata.ocrSource).toBe('markdown')

    // Re-export the same document with fewer chunks: the stale row disappears, the rest is updated.
    const fewer = chunks.slice(0, 1).map((c) => ({ ...c, contextSummary: 'güncellendi' }))
    const again = await exportToPgvector(client, fewer, { replaceDocument: true })
    expect(again.deleted).toBe(chunks.length - 1)
    const after = await client.query('SELECT context_summary FROM rag_chunks')
    expect(after.rows).toEqual([{ context_summary: 'güncellendi' }])

    const nearest = await client.query(
      "SELECT chunk_id FROM rag_chunks ORDER BY embedding <=> '[1,1,0.5]' LIMIT 1",
    )
    expect(nearest.rows[0].chunk_id).toBe(fewer[0]?.chunkId)
  })

  it('rejects chunks without embeddings and invalid table names', async () => {
    const plain = chunkMarkdown(md, { minTokens: 0 })
    await expect(exportToPgvector(client, plain)).rejects.toThrow(/no embeddings/)
    await expect(exportToPgvector(client, embedded(plain), { table: 'x; drop table y' })).rejects.toThrow(
      /Invalid table/,
    )
  })
})

describe('LanceDB export', () => {
  it('creates a table and replaces a document on re-export', async () => {
    const uri = await mkdtemp(join(tmpdir(), 'rc-lance-'))
    const chunks = embedded(chunkMarkdown(md, { minTokens: 0 }))
    const first = await exportToLanceDb(chunks, { uri })
    expect(first.written).toBe(chunks.length)
    const second = await exportToLanceDb(chunks.slice(0, 1), { uri, replaceDocument: true })
    expect(second.deleted).toBe(chunks.length - 1)
    const lancedb = await import('@lancedb/lancedb')
    const t = await (await lancedb.connect(uri)).openTable('rag_chunks')
    expect(await t.countRows()).toBe(1)
    const hits = await t.search([1, 1, 0.5]).limit(1).toArray()
    expect(hits[0]?.id).toBe(chunks[0]?.chunkId)
  })
})

describe('Qdrant export (REST, mocked)', () => {
  const server = new MockServer()
  beforeAll(async () => {
    await server.start()
  })
  afterAll(async () => {
    await server.stop()
  })
  beforeEach(() => server.reset())

  it('creates the collection when missing and upserts points with stable UUIDs', async () => {
    server.on('GET', '/collections/docs/exists', (_r, res) => json(res, 200, { result: { exists: false } }))
    server.on('PUT', '/collections/docs/points', (_r, res) =>
      json(res, 200, { result: { status: 'completed' } }),
    )
    server.on('PUT', '/collections/docs', (_r, res) => json(res, 200, { result: true }))
    server.on('POST', '/collections/docs/points/delete', (_r, res) =>
      json(res, 200, { result: { status: 'completed' } }),
    )
    const chunks = embedded(chunkMarkdown(md, { minTokens: 0 }))
    await exportToQdrant(chunks, {
      url: server.url,
      collection: 'docs',
      apiKey: 'q-key',
      replaceDocument: true,
    })
    const create = server.requests.find((r) => r.method === 'PUT' && r.path === '/collections/docs')
    expect(create?.body).toEqual({ vectors: { size: 3, distance: 'Cosine' } })
    expect(create?.headers['api-key']).toBe('q-key')
    const upsert = server.requests.find((r) => r.path.startsWith('/collections/docs/points?')) as any
    expect(upsert.body.points[0].id).toBe(pointId(chunks[0]?.chunkId ?? ''))
    expect(upsert.body.points[0].payload.chunkId).toBe(chunks[0]?.chunkId)
    expect(upsert.body.points[0].payload.embedding).toBeUndefined()
    expect(pointId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(pointId('a')).toBe(pointId('a'))
  })
})

describe('MCP server', () => {
  it('exposes search, get_chunk, get_page and list_documents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-mcp-'))
    const res = await processDocument(fixture('turkish.pdf'), { cache: { enabled: false } }, { env: {} })
    await res.save(dir)
    const server = await createMcpServer({ dirs: [dir] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new McpClient({ name: 'test', version: '1.0.0' })
    await client.connect(clientTransport)

    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'get_chunk',
      'get_page',
      'list_documents',
      'search',
    ])

    const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? ''
    const found = text(
      await client.callTool({ name: 'search', arguments: { query: 'potasyum kardiyak aritmi', topK: 2 } }),
    )
    expect(found).toContain('Hiperkalemi')
    const id = /\[([0-9a-f]{12}-[0-9a-f]{16})\]/.exec(found)?.[1] as string
    expect(
      text(await client.callTool({ name: 'get_chunk', arguments: { chunkId: id, neighbors: 1 } })),
    ).toContain(id)
    expect(
      text(await client.callTool({ name: 'get_page', arguments: { document: 'turkish.pdf', page: 1 } })),
    ).toContain('Elektrolit Bozuklukları')
    expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toMatch(
      /turkish\.pdf .*4 pages/,
    )
    const bad = await client.callTool({ name: 'get_chunk', arguments: { chunkId: 'nope' } })
    expect(bad.isError).toBe(true)
    await client.close()
    await server.close()
  })
})
