import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { homedir } from 'os'
import type { FileRef, CacheRef } from '../types.js'

export const DEFAULT_REGISTRY_PATH = `${homedir()}/.rag-chunker/registry.json`

// ─── Tipler ───────────────────────────────────────────────────────────────────

interface RegistryFileEntry {
  name: string
  uri: string
  mimeType: string
  expiresAt: string   // ISO 8601
}

interface RegistryCacheEntry {
  name: string
  model: string
  expireTime: string  // ISO 8601 (Gemini API'den gelir)
}

export interface Registry {
  files:  Record<string, RegistryFileEntry>    // hash → entry
  caches: Record<string, RegistryCacheEntry>   // `${hash}:${model}` → entry
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/** PDF içeriğinin SHA-256'sı — path değil içerik bazlı, dosya aynıysa her zaman aynı hash */
export function getPdfHash(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24)
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

function isExpired(dateStr: string, bufferMs = 120_000): boolean {
  return Date.now() + bufferMs >= new Date(dateStr).getTime()
}

function pruneExpired(registry: Registry): void {
  for (const k of Object.keys(registry.files)) {
    if (isExpired(registry.files[k].expiresAt)) delete registry.files[k]
  }
  for (const k of Object.keys(registry.caches)) {
    if (isExpired(registry.caches[k].expireTime)) delete registry.caches[k]
  }
}

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { files: {}, caches: {} }
  try {
    const reg = JSON.parse(readFileSync(path, 'utf-8')) as Registry
    pruneExpired(reg)
    return reg
  } catch {
    return { files: {}, caches: {} }
  }
}

export function saveRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(registry, null, 2), 'utf-8')
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export function findFileRef(registry: Registry, hash: string): FileRef | null {
  const e = registry.files[hash]
  if (!e || isExpired(e.expiresAt)) return null
  return { name: e.name, uri: e.uri, mimeType: e.mimeType }
}

export function findCacheRef(registry: Registry, hash: string, model: string): CacheRef | null {
  const e = registry.caches[`${hash}:${model}`]
  if (!e || isExpired(e.expireTime)) return null
  return { name: e.name, model: e.model, expireTime: e.expireTime }
}

export function getFileExpiry(registry: Registry, hash: string): string | null {
  return registry.files[hash]?.expiresAt ?? null
}

// ─── Write ────────────────────────────────────────────────────────────────────

/** Gemini File API dosyayı 48 saat tutar; 47h kullanıyoruz (temkinli) */
export function setFileRef(registry: Registry, hash: string, fileRef: FileRef): void {
  registry.files[hash] = {
    name: fileRef.name,
    uri: fileRef.uri,
    mimeType: fileRef.mimeType,
    expiresAt: new Date(Date.now() + 47 * 3_600_000).toISOString()
  }
}

export function setCacheRef(registry: Registry, hash: string, cacheRef: CacheRef): void {
  registry.caches[`${hash}:${cacheRef.model}`] = {
    name: cacheRef.name,
    model: cacheRef.model,
    expireTime: cacheRef.expireTime
  }
}

// ─── Yardımcı ─────────────────────────────────────────────────────────────────

/** "18sa 23dk" formatında kalan süre */
export function formatRemaining(isoDate: string): string {
  const ms = new Date(isoDate).getTime() - Date.now()
  if (ms <= 0) return 'süresi dolmuş'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`
}
