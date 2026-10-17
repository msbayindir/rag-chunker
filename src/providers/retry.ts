import { abortError, errorMessage, RagChunkerError } from '../errors.js'
import { sleep } from '../util/async.js'

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

export function statusOf(err: unknown): number | undefined {
  if (err instanceof RagChunkerError) return err.status
  const e = err as {
    status?: unknown
    status_code?: unknown
    code?: unknown
    response?: { status?: unknown }
  }
  for (const v of [e?.status, e?.status_code, e?.response?.status, e?.code]) {
    if (typeof v === 'number' && v >= 100 && v < 600) return v
  }
  return undefined
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const record = headers as Record<string, unknown>
  const v = record[name] ?? record[name.toLowerCase()]
  return typeof v === 'string' ? v : undefined
}

/** Delay requested by the server (Retry-After / retry-after-ms), capped at 60s. */
export function retryAfterMs(err: unknown): number | undefined {
  const headers =
    (err as { headers?: unknown; response?: { headers?: unknown } })?.headers ??
    (err as { response?: { headers?: unknown } })?.response?.headers
  const ms = headerValue(headers, 'retry-after-ms')
  if (ms && Number.isFinite(Number(ms))) return Math.min(60_000, Number(ms))
  const after = headerValue(headers, 'retry-after')
  if (!after) return undefined
  const seconds = Number(after)
  if (Number.isFinite(seconds)) return Math.min(60_000, seconds * 1000)
  const date = Date.parse(after)
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()))
  return undefined
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RagChunkerError) return err.retryable
  const status = statusOf(err)
  if (status !== undefined) return RETRYABLE_STATUS.has(status)
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return e.name === 'TimeoutError'
  const code =
    typeof e?.code === 'string' ? e.code : typeof e?.cause?.code === 'string' ? e.cause.code : undefined
  if (code && NETWORK_CODES.has(code)) return true
  const name = String(e?.name ?? '')
  if (/APIConnection(Timeout)?Error|FetchError/.test(name)) return true
  return /fetch failed|socket hang up|network/i.test(errorMessage(err))
}

export interface RetryOptions {
  maxRetries: number
  signal?: AbortSignal
  /** Base delay for exponential backoff in ms. */
  baseDelayMs?: number
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
}

/** Runs `fn` with exponential backoff (honouring Retry-After) for transient failures. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 1000
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal)
    try {
      return await fn(attempt)
    } catch (err) {
      if (options.signal?.aborted) throw abortError(options.signal)
      if (attempt >= options.maxRetries || !isRetryable(err)) throw err
      const backoff = Math.min(30_000, base * 2 ** attempt) * (0.75 + Math.random() * 0.5)
      const delay = Math.max(retryAfterMs(err) ?? 0, backoff)
      options.onRetry?.(attempt + 1, delay, err)
      await sleep(delay, options.signal)
    }
  }
}

/** Converts SDK/network errors into RagChunkerError with a hint. */
export function toProviderError(err: unknown, ref: string, keyEnv?: string[]): RagChunkerError {
  if (err instanceof RagChunkerError) return err
  const status = statusOf(err)
  const message = errorMessage(err)
  if (status === 401 || status === 403) {
    return new RagChunkerError('MISSING_API_KEY', `${ref}: authentication failed (${status}): ${message}`, {
      status,
      cause: err,
      hint:
        keyEnv && keyEnv.length > 0 ? `Check ${keyEnv.join(' / ')}` : 'Check the API key for this provider',
    })
  }
  if (status === 404) {
    return new RagChunkerError('MODEL_NOT_FOUND', `${ref}: model or endpoint not found: ${message}`, {
      status,
      cause: err,
      hint: 'Check the model name (provider/model) and the provider base URL.',
    })
  }
  if (status === undefined && isRetryable(err)) {
    return new RagChunkerError('PROVIDER_UNAVAILABLE', `${ref}: cannot reach the provider: ${message}`, {
      cause: err,
      retryable: true,
    })
  }
  return new RagChunkerError('PROVIDER_ERROR', `${ref}: ${message}`, {
    status,
    cause: err,
    retryable: status !== undefined && RETRYABLE_STATUS.has(status),
  })
}

/** Combines an optional caller signal with a timeout. */
export function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
