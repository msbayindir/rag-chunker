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

const PPU = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main'
const PPU_RAW = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main'

export const MODELS = {
  'pp-ocrv5-det': {
    id: 'pp-ocrv5-det',
    file: 'PP-OCRv5_mobile_det_infer.onnx',
    url: `${PPU}/detection/PP-OCRv5_mobile_det_infer.onnx`,
    sha256: 'd7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924',
    bytes: 4_748_769,
    license: 'Apache-2.0 (PaddleOCR PP-OCRv5)',
    description: 'OCR text detection (DBNet, mobile)',
  },
  'pp-ocrv5-rec-latin': {
    id: 'pp-ocrv5-rec-latin',
    file: 'latin_PP-OCRv5_mobile_rec_infer.onnx',
    url: `${PPU}/recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx`,
    sha256: '497dbed20b7fd86334c9deb5082c2958982a316bb16e3589ebc6502cd85cae79',
    bytes: 8_066_518,
    license: 'Apache-2.0 (PaddleOCR PP-OCRv5)',
    description: 'OCR text recognition, Latin scripts (Turkish, English, German, French, Spanish, …)',
  },
  'pp-ocrv5-dict-latin': {
    id: 'pp-ocrv5-dict-latin',
    file: 'ppocrv5_latin_dict.txt',
    url: `${PPU_RAW}/recognition/multi/latin/v5/ppocrv5_latin_dict.txt`,
    sha256: '7274e68c7675355e45dd75c360c83faa0d0624de33a704c799a7da8897662201',
    bytes: 2_617,
    license: 'Apache-2.0 (PaddleOCR PP-OCRv5)',
    description: 'Character table of the Latin recognition model',
  },
  'slanet-plus': {
    id: 'slanet-plus',
    file: 'SLANet_plus.onnx',
    url: `${PPU}/table/SLANet_plus.onnx`,
    sha256: 'd57a942af6a2f57d6a4a0372573c696a2379bf5857c45e2ac69993f3b334514b',
    bytes: 7_758_305,
    license: 'Apache-2.0 (PaddleOCR PP-StructureV2)',
    description: 'Table structure: rows, columns, merged cells and cell boxes from a table image',
  },
  'slanet-dict': {
    id: 'slanet-dict',
    file: 'table_structure_dict_ch.txt',
    url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/table_structure_dict_ch.txt',
    sha256: '68d344a84b726e043f390122240ff2b2ced2949b2a80ce9b61ae955054d190ef',
    bytes: 578,
    license: 'Apache-2.0 (PaddleOCR)',
    description: 'Structure tokens of the SLANet models',
  },
  'pp-doclayout-v3': {
    id: 'pp-doclayout-v3',
    file: 'PP-DocLayoutV3.onnx',
    url: 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main/layout/PP-DocLayoutV3.onnx',
    sha256: 'dc5670ebbb42e2ba4e41395fc55e8217b007134e8b9e35023d592a8fe040a288',
    bytes: 129_920_689,
    license: 'Apache-2.0 (PaddlePaddle PP-DocLayoutV3)',
    description: 'Page layout: 25 block classes with reading order',
  },
  'reranker-mmarco-minilm-arm64': {
    id: 'reranker-mmarco-minilm-arm64',
    file: 'mmarco-mMiniLMv2-L12-H384-v1.qint8-arm64.onnx',
    url: 'https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/main/onnx/model_qint8_arm64.onnx',
    sha256: '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
    bytes: 118_620_017,
    license: 'Apache-2.0 (cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)',
    description: 'Reranker: multilingual MiniLM cross-encoder, int8 for ARM',
  },
  'reranker-mmarco-minilm-x64': {
    id: 'reranker-mmarco-minilm-x64',
    file: 'mmarco-mMiniLMv2-L12-H384-v1.quint8-avx2.onnx',
    url: 'https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/main/onnx/model_quint8_avx2.onnx',
    sha256: '6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b',
    bytes: 118_620_016,
    license: 'Apache-2.0 (cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)',
    description: 'Reranker: multilingual MiniLM cross-encoder, uint8 for x86-64',
  },
  'reranker-mmarco-minilm-tokenizer': {
    id: 'reranker-mmarco-minilm-tokenizer',
    file: 'mmarco-mMiniLMv2-L12-H384-v1.tokenizer.json',
    url: 'https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/main/tokenizer.json',
    sha256: '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',
    bytes: 17_082_660,
    license: 'Apache-2.0 (cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)',
    description: 'Reranker tokenizer (XLM-R SentencePiece)',
  },
  'reranker-bge-base': {
    id: 'reranker-bge-base',
    file: 'bge-reranker-base.quantized.onnx',
    url: 'https://huggingface.co/onnx-community/bge-reranker-base-ONNX/resolve/main/onnx/model_quantized.onnx',
    sha256: '46a1bb4cf46ff1e300d27589d620141fbf04fc0eaf8e7bb6dea5e044475ff387',
    bytes: 279_252_659,
    license: 'MIT (BAAI/bge-reranker-base)',
    description: 'Reranker: BGE base cross-encoder, uint8',
  },
  'reranker-bge-base-tokenizer': {
    id: 'reranker-bge-base-tokenizer',
    file: 'bge-reranker-base.tokenizer.json',
    url: 'https://huggingface.co/onnx-community/bge-reranker-base-ONNX/resolve/main/tokenizer.json',
    sha256: '14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf',
    bytes: 17_082_798,
    license: 'MIT (BAAI/bge-reranker-base)',
    description: 'Reranker tokenizer (XLM-R SentencePiece)',
  },
  'reranker-bge-m3': {
    id: 'reranker-bge-m3',
    file: 'bge-reranker-v2-m3.quantized.onnx',
    url: 'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/onnx/model_quantized.onnx',
    sha256: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
    bytes: 570_727_094,
    license: 'Apache-2.0 (BAAI/bge-reranker-v2-m3)',
    description: 'Reranker: BGE v2 m3 cross-encoder (100+ languages), uint8',
  },
  'reranker-bge-m3-tokenizer': {
    id: 'reranker-bge-m3-tokenizer',
    file: 'bge-reranker-v2-m3.tokenizer.json',
    url: 'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/tokenizer.json',
    sha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
    bytes: 17_082_900,
    license: 'Apache-2.0 (BAAI/bge-reranker-v2-m3)',
    description: 'Reranker tokenizer (XLM-R SentencePiece)',
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
