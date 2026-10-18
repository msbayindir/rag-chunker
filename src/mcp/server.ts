import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { splitPages } from '../ocr/postprocess.js'
import { PACKAGE_VERSION } from '../output/manifest.js'
import { type LoadedOutput, readOutputDir } from '../output/writer.js'
import type { Embedder } from '../providers/types.js'
import { buildSearchIndex, type Reranker, rerank, search } from '../search/search.js'
import type { Chunk } from '../types.js'

export interface McpOptions {
  dirs: string[]
  /** Embeds queries for hybrid search when the chunks have vectors from the same model. */
  embedder?: Embedder
  /** Reorders the top candidates of every search. */
  reranker?: Reranker
  /** First-stage results handed to the reranker (default 30). */
  candidates?: number
}

function formatChunk(c: Chunk): string {
  const pages = c.pageStart === c.pageEnd ? `page ${c.pageStart}` : `pages ${c.pageStart}-${c.pageEnd}`
  const header = `[${c.chunkId}] ${c.source}, ${pages}${c.sectionPath.length ? ` — ${c.sectionPath.join(' › ')}` : ''}`
  return `${header}\n${c.contextSummary ? `Context: ${c.contextSummary}\n` : ''}${c.rawContent}`
}

/** Builds an MCP server that lets agents search and read rag-chunker output folders. */
export async function createMcpServer(options: McpOptions): Promise<McpServer> {
  const outputs: LoadedOutput[] = []
  for (const dir of options.dirs) outputs.push(await readOutputDir(dir))
  const chunks = outputs.flatMap((o) => o.chunks)
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  const index = buildSearchIndex(chunks)
  const useVectors = !!options.embedder && index.hasVectors

  const server = new McpServer({ name: 'rag-chunker', version: PACKAGE_VERSION })

  server.registerTool(
    'search',
    {
      title: 'Search documents',
      description: `Find the most relevant passages in the indexed documents (${useVectors ? 'hybrid keyword + semantic' : 'keyword (BM25)'} search${options.reranker ? ', reranked by a cross-encoder' : ''}). Returns chunk ids, sources, pages and text.`,
      inputSchema: {
        query: z.string().min(1).describe('What to look for, in natural language'),
        topK: z.number().int().min(1).max(50).optional().describe('Number of results (default 5)'),
        document: z.string().optional().describe('Restrict to one document (file name or documentId)'),
      },
    },
    async ({ query, topK, document }) => {
      const pool = document
        ? buildSearchIndex(chunks.filter((c) => c.source === document || c.documentId === document))
        : index
      const queryVector = useVectors
        ? (await options.embedder?.embed([query], 'query'))?.vectors[0]
        : undefined
      const hits = options.reranker
        ? await rerank(pool, query, {
            reranker: options.reranker,
            topK: topK ?? 5,
            candidates: options.candidates,
            queryVector,
          })
        : search(pool, query, { topK: topK ?? 5, queryVector })
      const text =
        hits.length === 0
          ? 'No matching passages.'
          : hits
              .map((h) => `#${h.rank} (score ${h.score.toFixed(3)})\n${formatChunk(h.chunk)}`)
              .join('\n\n---\n\n')
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'get_chunk',
    {
      title: 'Read a chunk',
      description: 'Return a chunk by id, optionally with its neighbouring chunks for more context.',
      inputSchema: {
        chunkId: z.string().describe('Chunk id from search results'),
        neighbors: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe('Chunks to include before and after (default 0)'),
      },
    },
    async ({ chunkId, neighbors }) => {
      const chunk = byId.get(chunkId)
      if (!chunk) return { content: [{ type: 'text', text: `Unknown chunk id: ${chunkId}` }], isError: true }
      const list: Chunk[] = [chunk]
      let prev = chunk
      let next = chunk
      for (let i = 0; i < (neighbors ?? 0); i++) {
        const p = prev.prevChunkId ? byId.get(prev.prevChunkId) : undefined
        const n = next.nextChunkId ? byId.get(next.nextChunkId) : undefined
        if (p) {
          list.unshift(p)
          prev = p
        }
        if (n) {
          list.push(n)
          next = n
        }
      }
      return { content: [{ type: 'text', text: list.map(formatChunk).join('\n\n---\n\n') }] }
    },
  )

  server.registerTool(
    'get_page',
    {
      title: 'Read a page',
      description: 'Return the extracted markdown of one page of a document.',
      inputSchema: {
        document: z.string().describe('File name or documentId'),
        page: z.number().int().min(1).describe('1-based page number'),
      },
    },
    async ({ document, page }) => {
      const out = outputs.find(
        (o) => o.manifest.source.name === document || o.manifest.source.documentId === document,
      )
      if (!out) return { content: [{ type: 'text', text: `Unknown document: ${document}` }], isError: true }
      const found = splitPages(out.markdown).find((p) => p.pageNumber === page)
      return found
        ? { content: [{ type: 'text', text: found.markdown || '(no text on this page)' }] }
        : { content: [{ type: 'text', text: `Page ${page} not found` }], isError: true }
    },
  )

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'List the indexed documents with page and chunk counts.',
      inputSchema: {},
    },
    async () => {
      const text = outputs
        .map(
          (o) =>
            `${o.manifest.source.name} (documentId ${o.manifest.source.documentId.slice(0, 12)}…): ${o.structure?.pageCount ?? '?'} pages, ${o.chunks.length} chunks`,
        )
        .join('\n')
      return { content: [{ type: 'text', text: text || 'No documents loaded.' }] }
    },
  )

  return server
}
