import { createHash } from 'crypto'

/** SHA-256 of PDF content (first 24 hex chars). Content-based, not path-based. */
export function getPdfHash(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24)
}

/**
 * Combines PDF hash with API key fingerprint so that the same PDF
 * uploaded with different API keys gets separate cache entries.
 */
export function getRegistryKey(buffer: Buffer | Uint8Array, apiKey: string): string {
  const pdfHash = getPdfHash(buffer)
  const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
  return `${keyFingerprint}_${pdfHash}`
}
