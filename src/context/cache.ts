import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { homedir } from 'os'

export const DEFAULT_OCR_CACHE_PATH = `${homedir()}/.rag-chunker/ocr-cache.json`

export interface OcrEntry {
  /** Full document markdown with <!-- page N --> markers */
  markdown: string
  pageCount: number
  model: string
  /** ISO 8601 timestamp when this entry was written */
  cachedAt: string
}

interface OcrRegistry {
  ocr: Record<string, OcrEntry>
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

export function loadOcrRegistry(path: string): OcrRegistry {
  if (!existsSync(path)) return { ocr: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as OcrRegistry
  } catch {
    return { ocr: {} }
  }
}

export function saveOcrRegistry(path: string, registry: OcrRegistry): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(registry, null, 2), 'utf-8')
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

function isExpired(cachedAt: string, ttlDays: number): boolean {
  const cutoff = Date.now() - ttlDays * 86_400_000
  return new Date(cachedAt).getTime() < cutoff
}

export function findOcrEntry(
  registry: OcrRegistry,
  key: string,
  ttlDays: number
): OcrEntry | null {
  const entry = registry.ocr[key]
  if (!entry) return null
  if (isExpired(entry.cachedAt, ttlDays)) return null
  return entry
}

// ─── Write ────────────────────────────────────────────────────────────────────

export function setOcrEntry(
  registry: OcrRegistry,
  key: string,
  entry: OcrEntry
): void {
  registry.ocr[key] = entry
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/** Removes expired entries and returns the count removed. */
export function pruneOcrCache(registry: OcrRegistry, ttlDays: number): number {
  let removed = 0
  for (const k of Object.keys(registry.ocr)) {
    if (isExpired(registry.ocr[k]!.cachedAt, ttlDays)) {
      delete registry.ocr[k]
      removed++
    }
  }
  return removed
}

export function clearOcrCache(registry: OcrRegistry): void {
  registry.ocr = {}
}

export function listOcrEntries(registry: OcrRegistry): Array<{ key: string; entry: OcrEntry }> {
  return Object.entries(registry.ocr).map(([key, entry]) => ({ key, entry }))
}

/** Returns a human-readable age string like "3d ago" or "45m ago". */
export function formatCachedAt(cachedAt: string): string {
  const ageMs = Date.now() - new Date(cachedAt).getTime()
  const d = Math.floor(ageMs / 86_400_000)
  if (d > 0) return `${d}d ago`
  const h = Math.floor(ageMs / 3_600_000)
  if (h > 0) return `${h}h ago`
  const m = Math.floor(ageMs / 60_000)
  return `${m}m ago`
}
