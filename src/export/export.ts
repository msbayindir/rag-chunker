import { RagChunkerError } from '../errors.js'
import { requestJson } from '../providers/http.js'
import type { Chunk } from '../types.js'
import { batches } from '../util/async.js'
import { sha256 } from '../util/hash.js'
import { importOptional } from '../util/optional.js'

export type ExportTarget = 'pgvector' | 'qdrant' | 'lancedb'

export interface ExportResult {
  target: ExportTarget
  written: number
  /** Rows removed by replaceDocument (null when the backend does not report it). */
  deleted: number | null
  dimensions: number
  location: string
}

function requireVectors(chunks: Chunk[]): number {
  const dims = chunks[0]?.embedding.length ?? 0
  if (dims === 0 || chunks.some((c) => c.embedding.length !== dims)) {
    throw new RagChunkerError('INPUT_INVALID', 'These chunks have no embeddings', {
      hint: 'Run `process` with --embedding <model>, or pass --embedding to export to embed them now.',
    })
  }
  return dims
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

/** Minimal SQL client shape (node-postgres `Client`/`Pool` and PGlite both fit). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<unknown>
}

export function chunkMetadata(c: Chunk): Record<string, unknown> {
  return {
    mustPreserve: c.mustPreserve,
    ocrSource: c.ocrSource,
    prevChunkId: c.prevChunkId,
    nextChunkId: c.nextChunkId,
  }
}

/**
 * Upserts chunks into a pgvector table (created if missing). With `replaceDocument`, rows of the
 * same document that are no longer produced are deleted, so re-processing never leaves stale chunks.
 */
export async function exportToPgvector(
  client: SqlClient,
  chunks: Chunk[],
  options: { table?: string; replaceDocument?: boolean; createIndex?: boolean } = {},
): Promise<ExportResult> {
  const table = options.table ?? 'rag_chunks'
  if (!IDENT_RE.test(table)) throw new RagChunkerError('CONFIG_INVALID', `Invalid table name "${table}"`)
  const dims = requireVectors(chunks)
  await client.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {})
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      chunk_id text PRIMARY KEY,
      document_id text NOT NULL,
      source text NOT NULL,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      raw_content text NOT NULL,
      context_summary text NOT NULL,
      section_path text[] NOT NULL,
      page_start integer NOT NULL,
      page_end integer NOT NULL,
      content_type text NOT NULL,
      token_count integer NOT NULL,
      metadata jsonb NOT NULL,
      embedding vector(${dims}) NOT NULL
    )`,
  )
  await client.query(`CREATE INDEX IF NOT EXISTS ${table}_document_idx ON ${table} (document_id)`)
  if (options.createIndex) {
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${table}_embedding_idx ON ${table} USING hnsw (embedding vector_cosine_ops)`,
    )
  }
  let deleted = 0
  await client.query('BEGIN')
  try {
    if (options.replaceDocument) {
      const docs = [...new Set(chunks.map((c) => c.documentId))]
      const keep = chunks.map((c) => c.chunkId)
      const res = (await client.query(
        `DELETE FROM ${table} WHERE document_id = ANY($1::text[]) AND NOT (chunk_id = ANY($2::text[]))`,
        [docs, keep],
      )) as { rowCount?: number; affectedRows?: number }
      deleted = res.rowCount ?? res.affectedRows ?? 0
    }
    const cols = 14
    for (const group of batches(chunks, 100)) {
      const values: unknown[] = []
      const rows = group.map((c, r) => {
        values.push(
          c.chunkId,
          c.documentId,
          c.source,
          c.index,
          c.content,
          c.rawContent,
          c.contextSummary,
          c.sectionPath,
          c.pageStart,
          c.pageEnd,
          c.contentType,
          c.tokenCount,
          JSON.stringify(chunkMetadata(c)),
          `[${c.embedding.join(',')}]`,
        )
        const base = r * cols
        return `(${Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(', ')})`
      })
      await client.query(
        `INSERT INTO ${table} (chunk_id, document_id, source, chunk_index, content, raw_content, context_summary,
          section_path, page_start, page_end, content_type, token_count, metadata, embedding)
         VALUES ${rows.join(', ')}
         ON CONFLICT (chunk_id) DO UPDATE SET
           document_id = EXCLUDED.document_id, source = EXCLUDED.source, chunk_index = EXCLUDED.chunk_index,
           content = EXCLUDED.content, raw_content = EXCLUDED.raw_content, context_summary = EXCLUDED.context_summary,
           section_path = EXCLUDED.section_path, page_start = EXCLUDED.page_start, page_end = EXCLUDED.page_end,
           content_type = EXCLUDED.content_type, token_count = EXCLUDED.token_count, metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding`,
        values,
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
  return { target: 'pgvector', written: chunks.length, deleted, dimensions: dims, location: table }
}

/** Qdrant point ids must be unsigned integers or UUIDs: derive a stable UUID from the chunk id. */
export function pointId(chunkId: string): string {
  const h = sha256(chunkId)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Upserts chunks into a Qdrant collection over its REST API (collection created if missing). */
export async function exportToQdrant(
  chunks: Chunk[],
  options: {
    url: string
    collection?: string
    apiKey?: string
    replaceDocument?: boolean
    signal?: AbortSignal
  },
): Promise<ExportResult> {
  const collection = options.collection ?? 'rag_chunks'
  const dims = requireVectors(chunks)
  const base = options.url.replace(/\/$/, '')
  const headers: Record<string, string> = options.apiKey ? { 'api-key': options.apiKey } : {}
  const req = <T>(path: string, method: 'GET' | 'PUT' | 'POST', body?: unknown) =>
    requestJson<T>(`${base}${path}`, {
      method,
      body,
      headers,
      timeoutMs: 120_000,
      maxRetries: 3,
      signal: options.signal,
    })

  const exists = await req<{ result?: { exists?: boolean } }>(
    `/collections/${encodeURIComponent(collection)}/exists`,
    'GET',
  )
    .then((r) => r?.result?.exists === true)
    .catch(() => false)
  if (!exists) {
    await req(`/collections/${encodeURIComponent(collection)}`, 'PUT', {
      vectors: { size: dims, distance: 'Cosine' },
    })
  }
  let deleted: number | null = 0
  if (options.replaceDocument) {
    const docs = [...new Set(chunks.map((c) => c.documentId))]
    await req(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, 'POST', {
      filter: {
        must: [{ key: 'documentId', match: { any: docs } }],
        must_not: [{ key: 'chunkId', match: { any: chunks.map((c) => c.chunkId) } }],
      },
    })
    deleted = null
  }
  for (const group of batches(chunks, 128)) {
    await req(`/collections/${encodeURIComponent(collection)}/points?wait=true`, 'PUT', {
      points: group.map((c) => ({
        id: pointId(c.chunkId),
        vector: c.embedding,
        payload: { ...c, embedding: undefined, ...chunkMetadata(c) },
      })),
    })
  }
  return {
    target: 'qdrant',
    written: chunks.length,
    deleted,
    dimensions: dims,
    location: `${base}/collections/${collection}`,
  }
}

/** Writes chunks to a LanceDB table (embedded database in a local folder). */
export async function exportToLanceDb(
  chunks: Chunk[],
  options: { uri: string; table?: string; replaceDocument?: boolean },
): Promise<ExportResult> {
  const table = options.table ?? 'rag_chunks'
  const dims = requireVectors(chunks)
  const lancedb = await importOptional(
    '@lancedb/lancedb',
    'Exporting to LanceDB',
    () => import('@lancedb/lancedb'),
  )
  const db = await lancedb.connect(options.uri)
  const rows = chunks.map((c) => ({
    id: c.chunkId,
    documentId: c.documentId,
    source: c.source,
    chunkIndex: c.index,
    content: c.content,
    rawContent: c.rawContent,
    contextSummary: c.contextSummary,
    sectionPath: c.sectionPath.join(' > '),
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    contentType: c.contentType,
    tokenCount: c.tokenCount,
    vector: c.embedding,
  }))
  const names = await db.tableNames()
  let deleted = 0
  if (names.includes(table)) {
    const t = await db.openTable(table)
    const ids = rows.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(', ')
    if (options.replaceDocument) {
      const docs = [...new Set(chunks.map((c) => `'${c.documentId}'`))].join(', ')
      const before = await t.countRows(`documentId IN (${docs})`)
      await t.delete(`documentId IN (${docs})`)
      deleted = Math.max(0, before - rows.length)
    } else {
      await t.delete(`id IN (${ids})`)
    }
    await t.add(rows)
  } else {
    await db.createTable(table, rows)
  }
  return {
    target: 'lancedb',
    written: rows.length,
    deleted,
    dimensions: dims,
    location: `${options.uri}#${table}`,
  }
}
