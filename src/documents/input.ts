import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { RagChunkerError } from '../errors.js'
import { sha256 } from '../util/hash.js'

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'image' | 'markdown'

export interface DocumentInput {
  kind: DocumentKind
  bytes: Uint8Array
  /** File name used as `source` in chunks. */
  name: string
  mime: string
  /** sha256 of the bytes. */
  documentId: string
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  markdown: 'text/markdown',
}

export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.md',
  '.markdown',
  '.txt',
]

function startsWith(bytes: Uint8Array, ...sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b)
}

function imageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (
    startsWith(bytes, 0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42
  ) {
    return 'image/webp'
  }
  return undefined
}

function zipKind(bytes: Uint8Array): 'docx' | 'pptx' | undefined {
  if (!startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) return undefined
  // Office files list their main part names in the first entries; scanning the raw bytes is enough
  // to tell Word and PowerPoint apart without unzipping.
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1 << 20))).toString('latin1')
  if (head.includes('word/')) return 'docx'
  if (head.includes('ppt/')) return 'pptx'
  return undefined
}

/** Detects the document kind from magic bytes, falling back to the file extension. */
export function detectKind(bytes: Uint8Array, name: string): { kind: DocumentKind; mime: string } {
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) return { kind: 'pdf', mime: MIME.pdf as string }
  const img = imageMime(bytes)
  if (img) return { kind: 'image', mime: img }
  const zip = zipKind(bytes)
  if (zip) return { kind: zip, mime: MIME[zip] as string }

  const ext = extname(name).toLowerCase().slice(1)
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return { kind: 'markdown', mime: 'text/markdown' }
  if (ext === 'docx' || ext === 'pptx') {
    throw new RagChunkerError('INPUT_INVALID', `${name} does not look like a valid .${ext} file`)
  }
  if (looksLikeText(bytes)) return { kind: 'markdown', mime: 'text/markdown' }
  throw new RagChunkerError('UNSUPPORTED_INPUT', `Unsupported file type: ${name}`, {
    hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
  })
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096)
  if (sample.length === 0) return true
  let control = 0
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) control++
  if (control > 0) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  }
}

/** Reads a document from a path or bytes. */
export async function readDocument(input: string | Uint8Array, name?: string): Promise<DocumentInput> {
  let bytes: Uint8Array
  let fileName: string
  if (typeof input === 'string') {
    const info = await stat(input).catch(() => null)
    if (!info) throw new RagChunkerError('INPUT_INVALID', `File not found: ${input}`)
    if (!info.isFile()) throw new RagChunkerError('INPUT_INVALID', `Not a file: ${input}`)
    bytes = new Uint8Array(await readFile(input))
    fileName = name ?? basename(input)
  } else {
    bytes = input
    fileName = name ?? 'document'
  }
  if (bytes.length === 0) throw new RagChunkerError('INPUT_INVALID', `${fileName} is empty`)
  const { kind, mime } = detectKind(bytes, fileName)
  return { kind, bytes, name: fileName, mime, documentId: sha256(bytes) }
}
