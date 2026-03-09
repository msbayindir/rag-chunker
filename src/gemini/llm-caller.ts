function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getStatus(error: unknown): number | null {
  if (error !== null && typeof error === 'object') {
    const e = error as Record<string, unknown>
    if (typeof e['status'] === 'number') return e['status']
    if (typeof e['httpStatus'] === 'number') return e['httpStatus']
    if (typeof e['code'] === 'number') return e['code']
  }
  return null
}

export function isNonRetryable(error: unknown): boolean {
  const status = getStatus(error)
  return status !== null && [400, 401, 403].includes(status)
}

/**
 * JSON bloğunu modelin çıktısından güvenli şekilde ayıklar.
 * Markdown code fence, önceki açıklama metni veya sonraki metin varsa da çalışır.
 */
export function extractJson(raw: string): string {
  // Markdown code fence'i soy
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (stripped.startsWith('{')) return stripped

  // Yanıt içinde ilk { ... } bloğunu bul (model açıklama metni eklemiş olabilir)
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) return match[0]

  return stripped
}

/**
 * Herhangi bir hata için retry uygular (400/401/403 hariç).
 * Bilinmeyen hatalar (ağ, parse vs.) da üstel bekleme ile yeniden denenir.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (isNonRetryable(err)) throw err
      if (attempt < maxAttempts - 1) {
        const waitMs = Math.min(Math.pow(2, attempt) * 1000, 30_000)
        await sleep(waitMs)
      }
    }
  }
  throw lastErr
}
