import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from '../config/schema.js'
import { RagChunkerError } from '../errors.js'
import type { Reranker } from '../search/search.js'
import { ensureModel, hasModel, type ModelId } from './models.js'
import { hasOnnxRuntime, loadOnnxRuntime, sessionFor } from './runtime.js'

/**
 * Local cross-encoder rerankers on ONNX Runtime: a query and a passage go through the model
 * together and come out as one relevance score. The tokenizer is SentencePiece Unigram (XLM-R
 * vocabulary), implemented here from the model's `tokenizer.json`, so no extra dependency.
 */

export const RERANKERS = {
  'mmarco-minilm': {
    label: 'mMARCO mMiniLMv2-L12 (118M, 14 languages + transfer, 120 MB)',
    model: (process.arch === 'arm64'
      ? 'reranker-mmarco-minilm-arm64'
      : 'reranker-mmarco-minilm-x64') as ModelId,
    tokenizer: 'reranker-mmarco-minilm-tokenizer' as ModelId,
    maxLength: 512,
  },
  'bge-reranker-base': {
    label: 'BGE reranker base (278M, 280 MB)',
    model: 'reranker-bge-base' as ModelId,
    tokenizer: 'reranker-bge-base-tokenizer' as ModelId,
    maxLength: 512,
  },
  'bge-reranker-v2-m3': {
    label: 'BGE reranker v2 m3 (568M, 100+ languages, 570 MB, slow on CPU)',
    model: 'reranker-bge-m3' as ModelId,
    tokenizer: 'reranker-bge-m3-tokenizer' as ModelId,
    maxLength: 1024,
  },
} as const

export type RerankerId = keyof typeof RERANKERS
export const DEFAULT_RERANKER: RerankerId = 'mmarco-minilm'
export const RERANKER_IDS = Object.keys(RERANKERS) as RerankerId[]

export function isRerankerId(value: string): value is RerankerId {
  return value in RERANKERS
}

/** True when the model and tokenizer files of a reranker are downloaded. */
export async function hasReranker(id: RerankerId = DEFAULT_RERANKER, dir?: string): Promise<boolean> {
  const spec = RERANKERS[id]
  const [m, t] = await Promise.all([hasModel(spec.model, dir), hasModel(spec.tokenizer, dir)])
  return m && t
}

const UNK_PENALTY = 10
const METASPACE = '▁'

export interface TokenizerJson {
  model: { type: string; unk_id?: number; vocab: Array<[string, number]> }
  added_tokens?: Array<{ id: number; content: string }>
}

/**
 * SentencePiece Unigram tokenizer as HF `tokenizers` runs it: NFKC, whitespace split, metaspace
 * prefix, then the Viterbi segmentation that maximises the summed token scores, unknown characters
 * with a penalty (consecutive ones fused).
 */
export class UnigramTokenizer {
  private readonly scores = new Map<string, number>()
  private readonly ids = new Map<string, number>()
  private readonly minScore: number
  private readonly maxLen: number
  readonly unkId: number
  readonly bos: number
  readonly eos: number
  readonly pad: number

  constructor(json: TokenizerJson) {
    if (json.model.type !== 'Unigram') {
      throw new RagChunkerError('UNSUPPORTED_INPUT', `Unsupported tokenizer model: ${json.model.type}`)
    }
    let min = 0
    let maxLen = 1
    json.model.vocab.forEach(([token, score], id) => {
      this.scores.set(token, score)
      this.ids.set(token, id)
      if (score < min) min = score
      const len = Array.from(token).length
      if (len > maxLen) maxLen = len
    })
    this.minScore = min
    this.maxLen = maxLen
    this.unkId = json.model.unk_id ?? 0
    const special = (content: string, fallback: number) =>
      json.added_tokens?.find((t) => t.content === content)?.id ?? this.ids.get(content) ?? fallback
    this.bos = special('<s>', 0)
    this.pad = special('<pad>', 1)
    this.eos = special('</s>', 2)
  }

  /** NFKC, control characters out, every whitespace run one space (what the precompiled charsmap does, near enough). */
  static normalize(text: string): string {
    return text
      .normalize('NFKC')
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** Token ids of a text, without special tokens. */
  encode(text: string): number[] {
    const out: number[] = []
    for (const word of UnigramTokenizer.normalize(text).split(' ')) {
      if (word === '') continue
      out.push(...this.segment(METASPACE + word))
    }
    return out
  }

  /** `<s> a </s></s> b </s>`, `b` (then `a`) cut to fit `maxLength`. */
  encodePair(a: string, b: string, maxLength: number, maxA = 128): number[] {
    let x = this.encode(a).slice(0, maxA)
    let y = this.encode(b)
    const room = maxLength - 4
    if (x.length > room) x = x.slice(0, room)
    if (x.length + y.length > room) y = y.slice(0, room - x.length)
    return [this.bos, ...x, this.eos, this.eos, ...y, this.eos]
  }

  private segment(piece: string): number[] {
    const chars = Array.from(piece)
    const n = chars.length
    const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY)
    const backLen = new Int32Array(n + 1)
    const backId = new Int32Array(n + 1)
    best[0] = 0
    for (let i = 0; i < n; i++) {
      const from = best[i] as number
      if (from === Number.NEGATIVE_INFINITY) continue
      let single = false
      for (let len = 1; len <= Math.min(this.maxLen, n - i); len++) {
        const sub = chars.slice(i, i + len).join('')
        const score = this.scores.get(sub)
        if (score === undefined) continue
        if (len === 1) single = true
        const candidate = from + score
        if (candidate > (best[i + len] as number)) {
          best[i + len] = candidate
          backLen[i + len] = len
          backId[i + len] = this.ids.get(sub) as number
        }
      }
      if (!single) {
        const candidate = from + this.minScore - UNK_PENALTY
        if (candidate > (best[i + 1] as number)) {
          best[i + 1] = candidate
          backLen[i + 1] = 1
          backId[i + 1] = this.unkId
        }
      }
    }
    const ids: number[] = []
    for (let pos = n; pos > 0; pos -= backLen[pos] as number) ids.push(backId[pos] as number)
    ids.reverse()
    return ids.filter((id, i) => !(id === this.unkId && ids[i - 1] === this.unkId))
  }
}

export async function loadTokenizer(path: string): Promise<UnigramTokenizer> {
  return new UnigramTokenizer(JSON.parse(await readFile(path, 'utf8')) as TokenizerJson)
}

export interface RerankerOptions {
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
  /** Pairs scored per model run (default 8). */
  batchSize?: number
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** Downloads the reranker on first use and returns a scorer: relevance in 0–1 per (query, text) pair. */
export async function createReranker(
  id: RerankerId = DEFAULT_RERANKER,
  options: RerankerOptions = {},
): Promise<Reranker> {
  const spec = RERANKERS[id]
  const fetchOne = (m: ModelId) =>
    ensureModel(m, {
      dir: options.modelsDir,
      signal: options.signal,
      onProgress: (done, total) => options.onModelDownload?.(m, done, total),
    })
  const [modelPath, tokenizerPath] = await Promise.all([fetchOne(spec.model), fetchOne(spec.tokenizer)])
  const [rt, tokenizer] = await Promise.all([loadOnnxRuntime('Reranking'), loadTokenizer(tokenizerPath)])
  const batchSize = options.batchSize ?? 8
  return {
    id,
    async score(query, texts, signal) {
      if (texts.length === 0) return []
      const session = await sessionFor(modelPath, 'Reranking')
      const encoded = texts.map((t) => tokenizer.encodePair(query, t, spec.maxLength))
      const out: number[] = new Array(texts.length).fill(0)
      for (let start = 0; start < encoded.length; start += batchSize) {
        if (signal?.aborted) throw new RagChunkerError('ABORTED', 'Reranking was cancelled')
        const batch = encoded.slice(start, start + batchSize)
        const width = Math.max(...batch.map((b) => b.length))
        const ids = new BigInt64Array(batch.length * width).fill(BigInt(tokenizer.pad))
        const mask = new BigInt64Array(batch.length * width)
        batch.forEach((b, row) => {
          b.forEach((id, col) => {
            ids[row * width + col] = BigInt(id)
            mask[row * width + col] = 1n
          })
        })
        const feeds: Record<string, InstanceType<typeof rt.Tensor>> = {}
        for (const name of session.inputNames) {
          if (name === 'input_ids') feeds[name] = new rt.Tensor('int64', ids, [batch.length, width])
          else if (name === 'attention_mask')
            feeds[name] = new rt.Tensor('int64', mask, [batch.length, width])
          else if (name === 'token_type_ids')
            feeds[name] = new rt.Tensor('int64', new BigInt64Array(batch.length * width), [
              batch.length,
              width,
            ])
        }
        const result = await session.run(feeds)
        const logits = result[session.outputNames[0] as string]
        if (!logits) throw new RagChunkerError('PROVIDER_ERROR', 'The reranker returned no logits')
        const data = logits.data as ArrayLike<number>
        const perRow = (logits.dims[1] as number | undefined) ?? 1
        batch.forEach((_b, row) => {
          out[start + row] = sigmoid(Number(data[row * perRow]))
        })
      }
      return out
    },
  }
}

export interface RerankPlan {
  /** Local model to use; null when reranking is off or hosted. */
  id: RerankerId | null
  /** Hosted reranker as "provider/model" (cohere, jina) when one is configured. */
  ref?: string
  /** True when the local model still has to be downloaded. */
  download: boolean
  /** Why it is off, for `--dry-run` and doctor. */
  reason?: string
}

/** Names the reranker a plan stands for, for messages. */
export function rerankerName(plan: RerankPlan): string | null {
  return plan.ref ?? plan.id
}

/**
 * Which reranker a command uses: a flag wins (`--rerank [model]`, `--no-rerank`), then
 * `rerank.engine`; "auto" means the default model when it is already downloaded.
 */
export async function resolveReranker(
  config: ResolvedConfig,
  override?: string | boolean,
  dir?: string,
): Promise<RerankPlan> {
  if (override === false) return { id: null, download: false, reason: 'disabled by flag' }
  const engine = config.rerank.engine
  let id: RerankerId | null = null
  const hosted = (value: string) => value.includes('/')
  if (typeof override === 'string') {
    if (hosted(override)) return { id: null, ref: override, download: false }
    if (!isRerankerId(override)) {
      throw new RagChunkerError('CONFIG_INVALID', `Unknown reranker: ${override}`, {
        hint: `Choose one of ${RERANKER_IDS.join(', ')}, or a hosted one as provider/model (cohere/rerank-v3.5).`,
      })
    }
    id = override
  } else if (override === true) {
    if (hosted(engine)) return { id: null, ref: engine, download: false }
    id = engine === 'auto' || engine === 'off' || !isRerankerId(engine) ? DEFAULT_RERANKER : engine
  } else if (engine === 'off') return { id: null, download: false, reason: 'rerank.engine is off' }
  else if (hosted(engine)) return { id: null, ref: engine, download: false }
  else if (engine !== 'auto' && isRerankerId(engine)) id = engine
  if (!(await hasOnnxRuntime())) {
    if (id) {
      throw new RagChunkerError('PROVIDER_UNAVAILABLE', 'Reranking needs onnxruntime-node', {
        hint: 'npm install onnxruntime-node',
      })
    }
    return { id: null, download: false, reason: 'onnxruntime-node not installed' }
  }
  if (id) return { id, download: !(await hasReranker(id, dir)) }
  if (await hasReranker(DEFAULT_RERANKER, dir)) return { id: DEFAULT_RERANKER, download: false }
  return { id: null, download: false, reason: 'model not downloaded (use --rerank once)' }
}
