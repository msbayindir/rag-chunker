import { RagChunkerError } from '../errors.js'
import { timeoutSignal, withRetry } from './retry.js'

export interface RequestJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs: number
  maxRetries: number
  signal?: AbortSignal
}

/** HTTP error that keeps status and headers so the retry policy can read Retry-After. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Headers,
    readonly body: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** fetch + JSON with timeout, abort and retries for transient failures. */
export async function requestJson<T>(url: string, options: RequestJsonOptions): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: timeoutSignal(options.timeoutMs, options.signal),
      })
      const text = await res.text()
      if (!res.ok) {
        let detail = text.slice(0, 500)
        try {
          const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; detail?: unknown }
          const m = parsed.message ?? parsed.detail ?? parsed.error
          if (m) detail = typeof m === 'string' ? m : JSON.stringify(m).slice(0, 500)
        } catch {
          // keep raw text
        }
        throw new HttpError(res.status, `HTTP ${res.status}: ${detail}`, res.headers, text)
      }
      if (text.trim() === '') return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new RagChunkerError('PROVIDER_ERROR', `Invalid JSON from ${new URL(url).host}`)
      }
    },
    { maxRetries: options.maxRetries, signal: options.signal },
  )
}
