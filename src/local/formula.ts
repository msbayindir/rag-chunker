import { importOptional } from '../util/optional.js'
import { ensureModel, type ModelId, modelsDir } from './models.js'

/**
 * Local formula recognition: a cropped display formula goes into texify2 (a vision encoder–decoder,
 * 8-bit ONNX, about 320 MB) and comes back as LaTeX. The model runs through the optional
 * `@huggingface/transformers` package, which brings the image preprocessing, the tokenizer and the
 * decoding loop; the files come from the catalogue (sha256 verified) so nothing is fetched from
 * Hugging Face at run time.
 */

export const FORMULA_MODELS: readonly ModelId[] = [
  'texify2-config',
  'texify2-generation',
  'texify2-preprocessor',
  'texify2-tokenizer',
  'texify2-tokenizer-config',
  'texify2-encoder',
  'texify2-decoder',
]

export interface FormulaRecogniser {
  /** LaTeX for the formula in a PNG crop, or null when the model produced nothing usable. */
  recognise: (png: Uint8Array, signal?: AbortSignal) => Promise<string | null>
}

export interface FormulaRecogniserOptions {
  modelsDir?: string
  onModelDownload?: (file: string, done: number, total: number) => void
  signal?: AbortSignal
}

type Transformers = typeof import('@huggingface/transformers')
type Texify = import('@huggingface/transformers').ImageToTextPipeline

/**
 * One loaded model per models directory for the whole process: the pipeline takes seconds to
 * build and hundreds of MB of memory, and a folder of documents must not pay that per file.
 */
const loaded = new Map<string, Promise<Texify>>()

function loadTexify(tf: Transformers, dir: string, options: FormulaRecogniserOptions): Promise<Texify> {
  let p = loaded.get(dir)
  if (!p) {
    p = (async () => {
      await Promise.all(
        FORMULA_MODELS.map((id) =>
          ensureModel(id, {
            dir,
            signal: options.signal,
            onProgress: (done, total) => options.onModelDownload?.(id, done, total),
          }),
        ),
      )
      // Models are read from our directory only; `texify2/` holds the Hugging Face layout.
      tf.env.allowRemoteModels = false
      tf.env.allowLocalModels = true
      tf.env.localModelPath = dir
      return (await tf.pipeline('image-to-text', 'texify2', { dtype: 'q8' })) as Texify
    })()
    p.catch(() => loaded.delete(dir))
    loaded.set(dir, p)
  }
  return p
}

/**
 * Returns a recogniser. The optional package is checked right away (so a required recogniser
 * fails before any page is read); the model files are downloaded and the model is loaded on the
 * first formula, once per process.
 */
export async function createFormulaRecogniser(
  options: FormulaRecogniserOptions = {},
): Promise<FormulaRecogniser> {
  const dir = options.modelsDir ?? modelsDir()
  const tf = await importOptional(
    '@huggingface/transformers',
    'Formula recognition',
    () => import('@huggingface/transformers'),
  )
  return {
    recognise: async (png, signal) => {
      signal?.throwIfAborted()
      const texify = await loadTexify(tf, dir, options)
      const image = await tf.RawImage.fromBlob(new Blob([png as BlobPart], { type: 'image/png' }))
      // The decoder loop stops at the next step when the signal fires.
      const stop = new tf.InterruptableStoppingCriteria()
      const onAbort = () => stop.interrupt()
      signal?.addEventListener('abort', onAbort, { once: true })
      let out: Array<{ generated_text: string }>
      try {
        out = (await texify(image, { max_new_tokens: 384, stopping_criteria: stop } as object)) as Array<{
          generated_text: string
        }>
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.throwIfAborted()
      return cleanLatex(out[0]?.generated_text ?? '')
    },
  }
}

/**
 * The model's text as a bare LaTeX body: `$…$`, `$$…$$` and `\[…\]` wrappers removed, whitespace
 * folded; null for empty output or for prose the model hallucinates on crops that are not
 * formulas (no LaTeX command, no operator, mostly words).
 */
export function cleanLatex(text: string): string | null {
  let s = text.trim()
  if (s === '') return null
  // Equation numbers the model copies from the margin ("(15) …"), then the math delimiters; a
  // bare `$` has no place inside the body (the model sometimes closes early: "…$.").
  s = s.replace(/^\s*\(\d{1,3}(?:\.\d{1,3})?\)\s*/, '')
  s = s.replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, '')
  s = s.replace(/(^|[^\\])\$+/g, '$1')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/[.,;:]\s*$/, '')
  if (s === '') return null
  const words = (s.match(/[A-Za-z]{4,}/g) ?? []).length
  const mathy = /\\[a-zA-Z]+|[=+\-*/^_<>]|\d/.test(s)
  if (!mathy || (words >= 6 && !s.includes('\\'))) return null
  return s
}
