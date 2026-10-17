export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'MISSING_API_KEY'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'MODEL_NOT_FOUND'
  | 'CAPABILITY_MISSING'
  | 'STRUCTURED_OUTPUT_FAILED'
  | 'UNSUPPORTED_INPUT'
  | 'INPUT_INVALID'
  | 'OPTIONAL_DEPENDENCY_MISSING'
  | 'ABORTED'
  | 'IO_ERROR'

export interface RagChunkerErrorOptions {
  hint?: string
  status?: number
  cause?: unknown
  retryable?: boolean
}

/**
 * The only error type thrown by rag-chunker. `code` is stable and safe to branch on;
 * `hint` is a short, human-readable suggestion for fixing the problem.
 */
export class RagChunkerError extends Error {
  readonly code: ErrorCode
  readonly hint: string | undefined
  readonly status: number | undefined
  readonly retryable: boolean

  constructor(code: ErrorCode, message: string, options: RagChunkerErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'RagChunkerError'
    this.code = code
    this.hint = options.hint
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

export function isRagChunkerError(err: unknown): err is RagChunkerError {
  return err instanceof RagChunkerError
}

export function abortError(signal?: AbortSignal): RagChunkerError {
  const reason = signal?.reason
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Aborted'
  return new RagChunkerError('ABORTED', message, { cause: reason })
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
