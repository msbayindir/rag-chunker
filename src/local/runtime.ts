import type * as ort from 'onnxruntime-node'
import { importOptional } from '../util/optional.js'

/**
 * ONNX Runtime for the local models (layout analysis, later OCR and rerankers). `onnxruntime-node`
 * is an optional dependency: a missing install surfaces as one actionable error, never a crash.
 */
export type OnnxRuntime = typeof ort

let runtime: Promise<OnnxRuntime> | null = null

export function loadOnnxRuntime(purpose = 'Local models'): Promise<OnnxRuntime> {
  runtime ??= importOptional('onnxruntime-node', purpose, () => import('onnxruntime-node')).catch((err) => {
    runtime = null
    throw err
  })
  return runtime
}

/** True when the runtime can be imported (used by `doctor` and the "auto" layout mode). */
export async function hasOnnxRuntime(): Promise<boolean> {
  try {
    await loadOnnxRuntime()
    return true
  } catch {
    return false
  }
}

const sessions = new Map<string, Promise<ort.InferenceSession>>()

/** One session per model file; creation is deduplicated across concurrent callers. */
export function sessionFor(modelPath: string, purpose: string): Promise<ort.InferenceSession> {
  let s = sessions.get(modelPath)
  if (!s) {
    s = loadOnnxRuntime(purpose).then((rt) =>
      rt.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }),
    )
    s.catch(() => sessions.delete(modelPath))
    sessions.set(modelPath, s)
  }
  return s
}
