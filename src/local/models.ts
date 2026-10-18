import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RagChunkerError } from '../errors.js'

/** Where downloaded model files live (override with RAG_CHUNKER_MODELS_DIR). */
export const DEFAULT_MODELS_DIR = join(homedir(), '.rag-chunker', 'models')

export interface ModelSpec {
  id: string
  file: string
  url: string
  sha256: string
  bytes: number
  license: string
  description: string
}

export const MODELS = {
  'pp-doclayout-v3': {
    id: 'pp-doclayout-v3',
    file: 'PP-DocLayoutV3.onnx',
    url: 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/layout/PP-DocLayoutV3.onnx',
    sha256: 'dc5670ebbb42e2ba4e41395fc55e8217b007134e8b9e35023d592a8fe040a288',
    bytes: 129_920_689,
    license: 'Apache-2.0 (PaddlePaddle PP-DocLayoutV3)',
    description: 'Page layout: 25 block classes with reading order',
  },
} as const satisfies Record<string, ModelSpec>

export type ModelId = keyof typeof MODELS

export function modelsDir(env: Record<string, string | undefined> = process.env): string {
  return env.RAG_CHUNKER_MODELS_DIR || DEFAULT_MODELS_DIR
}

export function modelPath(id: ModelId, dir = modelsDir()): string {
  return join(dir, MODELS[id].file)
}

/** True when the model file is already present with the expected size. */
export async function hasModel(id: ModelId, dir = modelsDir()): Promise<boolean> {
  try {
    const s = await stat(modelPath(id, dir))
    return s.size === MODELS[id].bytes
  } catch {
    return false
  }
}

export interface EnsureModelOptions {
  dir?: string
  /** Called with downloaded/total bytes while fetching. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** Override the download URL (mirrors, offline caches). */
  url?: string
  fetchImpl?: typeof fetch
}

/**
 * Returns the local path of a model, downloading and verifying it (sha256) on first use. A partial
 * download is written next to the target and renamed only after it checks out.
 */
export async function ensureModel(id: ModelId, options: EnsureModelOptions = {}): Promise<string> {
  const spec = MODELS[id]
  const dir = options.dir ?? modelsDir()
  const target = join(dir, spec.file)
  if (await hasModel(id, dir)) return target
  await downloadModel(spec, target, options)
  return target
}

/** Downloads `spec` to `target`, verifying size-independent sha256; leaves nothing behind on failure. */
export async function downloadModel(
  spec: Pick<ModelSpec, 'file' | 'url' | 'sha256' | 'bytes'>,
  target: string,
  options: EnsureModelOptions = {},
): Promise<void> {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const url = options.url ?? spec.url
  const doFetch = options.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(url, { signal: options.signal })
  } catch (err) {
    throw new RagChunkerError('PROVIDER_UNAVAILABLE', `Could not download ${spec.file} from ${url}`, {
      cause: err,
      hint: `Download it manually into ${dir} (sha256 ${spec.sha256}) or set RAG_CHUNKER_MODELS_DIR to a folder that has it.`,
    })
  }
  if (!res.ok || !res.body) {
    throw new RagChunkerError(
      'PROVIDER_ERROR',
      `Could not download ${spec.file}: HTTP ${res.status} from ${url}`,
      { status: res.status, hint: `Download it manually into ${dir} (sha256 ${spec.sha256}).` },
    )
  }
  const total = Number(res.headers.get('content-length')) || spec.bytes
  const partial = `${target}.part-${process.pid}`
  const hash = createHash('sha256')
  let done = 0
  try {
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      done += chunk.length
      options.onProgress?.(done, total)
    })
    await pipeline(body, createWriteStream(partial), { signal: options.signal })
    const digest = hash.digest('hex')
    if (digest !== spec.sha256) {
      throw new RagChunkerError(
        'INPUT_INVALID',
        `${spec.file} did not verify (sha256 ${digest}, expected ${spec.sha256})`,
        {
          hint: 'The download may be corrupt or the file changed upstream. Try again; if it persists, open an issue.',
        },
      )
    }
    await rename(partial, target)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }
}

/** Removes a downloaded model (or all of them). */
export async function removeModels(dir = modelsDir(), id?: ModelId): Promise<number> {
  let removed = 0
  for (const spec of Object.values(MODELS)) {
    if (id && spec.id !== id) continue
    const path = join(dir, spec.file)
    try {
      await access(path)
      await rm(path, { force: true })
      removed++
    } catch {
      // not present
    }
  }
  return removed
}
