function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isRetryable(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return [429, 500, 503, 504].includes(status)
  }
  return false
}

export function isNonRetryable(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return [400, 401, 403].includes(status)
  }
  return false
}

export function extractJson(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isNonRetryable(err)) throw err
      if (attempt === maxAttempts - 1) throw err
      if (isRetryable(err)) {
        await sleep(Math.min(Math.pow(2, attempt) * 1000, 30_000))
        continue
      }
      throw err
    }
  }
  throw new Error('unreachable')
}
