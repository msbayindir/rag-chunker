import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RagChunkerError } from '../errors.js'
import type { Chunk } from '../types.js'
import type { Manifest } from './manifest.js'
import type { DocumentStructure } from './structure.js'

export const OUTPUT_FILES = {
  chunks: 'chunks.jsonl',
  markdown: 'document.md',
  structure: 'structure.json',
  manifest: 'manifest.json',
} as const

export interface OutputPaths {
  dir: string
  chunks: string
  markdown: string
  structure: string
  manifest: string
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

export async function writeOutputs(
  dir: string,
  data: { chunks: Chunk[]; markdown: string; structure: DocumentStructure; manifest: Manifest },
): Promise<OutputPaths> {
  await mkdir(dir, { recursive: true })
  const paths: OutputPaths = {
    dir,
    chunks: join(dir, OUTPUT_FILES.chunks),
    markdown: join(dir, OUTPUT_FILES.markdown),
    structure: join(dir, OUTPUT_FILES.structure),
    manifest: join(dir, OUTPUT_FILES.manifest),
  }
  await atomicWrite(
    paths.chunks,
    data.chunks.map((c) => JSON.stringify(c)).join('\n') + (data.chunks.length ? '\n' : ''),
  )
  await atomicWrite(paths.markdown, `${data.markdown.trimEnd()}\n`)
  await atomicWrite(paths.structure, `${JSON.stringify(data.structure, null, 2)}\n`)
  // Manifest last: its presence marks a complete output directory.
  await atomicWrite(paths.manifest, `${JSON.stringify(data.manifest, null, 2)}\n`)
  return paths
}

export interface LoadedOutput {
  dir: string
  chunks: Chunk[]
  manifest: Manifest
  structure: DocumentStructure | null
  markdown: string
}

/** Reads an output directory written by `processDocument(...).save()` or the CLI. */
export async function readOutputDir(dir: string): Promise<LoadedOutput> {
  let manifestText: string
  try {
    manifestText = await readFile(join(dir, OUTPUT_FILES.manifest), 'utf8')
  } catch {
    throw new RagChunkerError(
      'INPUT_INVALID',
      `${dir} is not a rag-chunker output directory (no manifest.json)`,
    )
  }
  const manifest = JSON.parse(manifestText) as Manifest
  const chunksText = await readFile(join(dir, OUTPUT_FILES.chunks), 'utf8').catch(() => '')
  const chunks = chunksText
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as Chunk
      } catch {
        throw new RagChunkerError('INPUT_INVALID', `${OUTPUT_FILES.chunks} line ${i + 1} is not valid JSON`)
      }
    })
  const structureText = await readFile(join(dir, OUTPUT_FILES.structure), 'utf8').catch(() => null)
  const markdown = await readFile(join(dir, OUTPUT_FILES.markdown), 'utf8').catch(() => '')
  return {
    dir,
    chunks,
    manifest,
    structure: structureText ? (JSON.parse(structureText) as DocumentStructure) : null,
    markdown,
  }
}
