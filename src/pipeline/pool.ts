/**
 * Sliding window concurrency pool.
 * delayMs: her öğe başlamadan önce bekleme süresi (rate limit koruması).
 * signal: abort geldiğinde yeni öğe başlatmayı durdurur (mevcut in-flight biter).
 */
export async function processWithPool<T>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const executing = new Set<Promise<void>>()
  for (const item of items) {
    if (signal?.aborted) break
    if (delayMs > 0) {
      await new Promise<void>(r => setTimeout(r, delayMs))
    }
    if (signal?.aborted) break
    const p = fn(item).finally(() => executing.delete(p))
    executing.add(p)
    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}
