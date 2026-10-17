import { abortError, throwIfAborted } from '../errors.js'

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs `fn` over `items` with at most `concurrency` tasks in flight.
 * Results keep the input order. The first rejection stops scheduling new work and is rethrown
 * after in-flight tasks settle.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const limit = Math.max(1, Math.floor(concurrency))
  let next = 0
  let failure: { error: unknown } | null = null

  async function worker(): Promise<void> {
    while (failure === null) {
      if (signal?.aborted) {
        failure = { error: abortError(signal) }
        return
      }
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== null) throw (failure as { error: unknown }).error
  throwIfAborted(signal)
  return results
}

/** Splits `items` into consecutive groups of at most `size`. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const n = Math.max(1, Math.floor(size))
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}
