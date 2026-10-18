import type { ContentType } from './chunker/chunker.js'
import type { ChunkBox } from './documents/layout.js'

export type { ContentType } from './chunker/chunker.js'
export type { Box, ChunkBox } from './documents/layout.js'

/** One retrieval unit. A line of chunks.jsonl. */
export interface Chunk {
  /** `<documentId[0:12]>-<sha256(rawContent)[0:16]>`, with `-2`, `-3`… for duplicates. Stable across runs. */
  chunkId: string
  /** sha256 of the source file bytes. */
  documentId: string
  /** Source file name (or a caller-provided label). */
  source: string
  /** 0-based position in the document. */
  index: number
  /** What to embed: `Context: <summary>` + overlap + rawContent. */
  content: string
  /** Verbatim markdown of the chunk. */
  rawContent: string
  /** Contextual-retrieval summary, '' when the context stage is off or skipped this chunk. */
  contextSummary: string
  /** Tokens in `content` (o200k unless the estimate tokenizer is configured). */
  tokenCount: number
  contentType: ContentType
  /** Heading breadcrumb, root first. */
  sectionPath: string[]
  /** 1-based first page (slide number for PPTX, 1 for formats without pages). */
  pageStart: number
  /** 1-based last page. */
  pageEnd: number
  /** Which engine produced the text: text-layer, pp-ocr, mistral, <provider/model>, markdown, docx, pptx, xlsx, html. */
  ocrSource: string
  /**
   * Where the chunk's text sits on the page(s), as fractions of the page size with the origin at
   * the top-left: one box per paragraph, heading or list item. Empty when positions are unknown
   * (OCR'd pages, DOCX, PPTX, Markdown).
   */
  boxes: ChunkBox[]
  prevChunkId: string | null
  nextChunkId: string | null
  /** True for tables/code kept in their own chunk. */
  mustPreserve: boolean
  /** Embedding vector, [] when the embedding stage is off. */
  embedding: number[]
}
