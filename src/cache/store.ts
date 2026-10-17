import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashOf } from '../util/hash.js'

interface Envelope<T> {
  v: 1
  createdAt: number
  data: T
}

export interface CacheStats {
  entries: number
  bytes: number
  namespaces: Record<string, { entries: number; bytes: number }>
}

/**
 * Content-addressed JSON cache on disk. Writes are atomic (temp file + rename), so an
 * interrupted run never leaves a half-written entry; corrupt entries are treated as misses.
 * A store created with `dir = null` is a no-op.
 */
export class CacheStore {
  readonly dir: string | null

  constructor(dir: string | null) {
    this.dir = dir
  }

  get enabled(): boolean {
    return this.dir !== null
  }

  /** Builds a stable key from arbitrary JSON-serialisable parts. */
  key(...parts: unknown[]): string {
    return hashOf(...parts)
  }

  private path(namespace: string, key: string): string {
    return join(this.dir as string, namespace, key.slice(0, 2), `${key}.json`)
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    if (!this.dir) return undefined
    const file = this.path(namespace, key)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    try {
      const env = JSON.parse(text) as Envelope<T>
      if (env.v !== 1 || !('data' in env)) throw new Error('bad envelope')
      return env.data
    } catch {
      await unlink(file).catch(() => {})
      return undefined
    }
  }

  async set<T>(namespace: string, key: string, data: T): Promise<void> {
    if (!this.dir) return
    const file = this.path(namespace, key)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    const env: Envelope<T> = { v: 1, createdAt: Date.now(), data }
    await writeFile(tmp, JSON.stringify(env), 'utf8')
    await rename(tmp, file)
  }

  /** Returns the cached value or computes, stores and returns it. */
  async wrap<T>(
    namespace: string,
    key: string,
    compute: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get<T>(namespace, key)
    if (cached !== undefined) return { value: cached, hit: true }
    const value = await compute()
    await this.set(namespace, key, value)
    return { value, hit: false }
  }

  async stats(): Promise<CacheStats> {
    const out: CacheStats = { entries: 0, bytes: 0, namespaces: {} }
    if (!this.dir) return out
    for (const file of await walk(this.dir)) {
      if (!file.endsWith('.json')) continue
      const ns = file.slice((this.dir as string).length + 1).split(/[\\/]/)[0] ?? 'unknown'
      const size = (await stat(file).catch(() => null))?.size ?? 0
      out.entries++
      out.bytes += size
      const entry = out.namespaces[ns] ?? { entries: 0, bytes: 0 }
      out.namespaces[ns] = entry
      entry.entries++
      entry.bytes += size
    }
    return out
  }

  /** Removes entries older than `olderThanMs` (all entries when omitted). Returns the number removed. */
  async prune(olderThanMs?: number): Promise<number> {
    if (!this.dir) return 0
    const cutoff = olderThanMs === undefined ? Number.POSITIVE_INFINITY : Date.now() - olderThanMs
    let removed = 0
    for (const file of await walk(this.dir)) {
      if (file.endsWith('.tmp')) {
        await unlink(file).catch(() => {})
        continue
      }
      if (!file.endsWith('.json')) continue
      let createdAt = 0
      try {
        createdAt = (JSON.parse(await readFile(file, 'utf8')) as Envelope<unknown>).createdAt ?? 0
      } catch {
        createdAt = 0
      }
      if (olderThanMs === undefined || createdAt < cutoff) {
        await unlink(file).catch(() => {})
        removed++
      }
    }
    return removed
  }

  async clear(): Promise<void> {
    if (!this.dir) return
    await rm(this.dir, { recursive: true, force: true })
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}
