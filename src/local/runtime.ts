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

/** Where accelerated models run: Apple's CoreML, NVIDIA CUDA, or the CPU. */
export type Device = 'cpu' | 'coreml' | 'cuda'
export type DeviceChoice = Device | 'auto'

let configured: DeviceChoice = 'auto'
let resolved: Device | null = null
const fallbacks = new Set<string>()

/**
 * Sets the device accelerated models use (from `local.device`); sessions created afterwards
 * follow it. 'auto' picks CoreML on macOS and CUDA elsewhere when onnxruntime-node offers them.
 */
export function configureDevice(device: DeviceChoice): void {
  if (device !== configured) {
    configured = device
    resolved = null
  }
}

/** The device 'auto' resolved to (after the runtime loaded), or the configured one. */
export async function resolveDevice(): Promise<Device> {
  if (configured !== 'auto') return configured
  if (resolved) return resolved
  const rt = await loadOnnxRuntime()
  const offered = new Set((rt.listSupportedBackends?.() ?? []).map((b) => b.name))
  resolved =
    process.platform === 'darwin' && offered.has('coreml') ? 'coreml' : offered.has('cuda') ? 'cuda' : 'cpu'
  return resolved
}

/** Model files whose accelerated session failed and now run on the CPU (shown by `doctor`). */
export function deviceFallbacks(): string[] {
  return [...fallbacks]
}

const sessions = new Map<string, Promise<ort.InferenceSession>>()

export interface SessionOptions {
  /**
   * Run on the configured device instead of the CPU. Only models that gain from it ask: the text
   * detector and the CJK recogniser run about 4× and 2.5× faster on CoreML, while the layout
   * model, the table model, the Latin recogniser and the int8 rerankers are slower there.
   */
  accelerate?: boolean
}

/** One session per model file (and device); creation is deduplicated across concurrent callers. */
export async function sessionFor(
  modelPath: string,
  purpose: string,
  options: SessionOptions = {},
): Promise<ort.InferenceSession> {
  const device = options.accelerate ? await resolveDevice() : 'cpu'
  const key = `${device}:${modelPath}`
  let s = sessions.get(key)
  if (!s) {
    s = loadOnnxRuntime(purpose).then(async (rt) => {
      const create = (providers: string[]) =>
        rt.InferenceSession.create(modelPath, {
          executionProviders: providers,
          graphOptimizationLevel: 'all',
          // RAG_CHUNKER_THREADS caps the CPU threads per model (e.g. 2 on a laptop you keep using).
          ...(Number(process.env.RAG_CHUNKER_THREADS) > 0
            ? { intraOpNumThreads: Number(process.env.RAG_CHUNKER_THREADS) }
            : {}),
          // Decoder loops (SLANet) trip shape-inference warnings that are noise for users.
          logSeverityLevel: 3,
        })
      if (device === 'cpu') return create(['cpu'])
      try {
        return await create([device, 'cpu'])
      } catch {
        // The accelerator is offered but cannot take this model here: the CPU always can.
        fallbacks.add(modelPath)
        return create(['cpu'])
      }
    })
    s.catch(() => sessions.delete(key))
    sessions.set(key, s)
  }
  return s
}
