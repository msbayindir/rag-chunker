import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CacheStore } from '../../src/cache/store.js'
import { batches, mapPool, sleep } from '../../src/util/async.js'
import { hashOf, stableStringify } from '../../src/util/hash.js'

describe('CacheStore', () => {
  it('stores and returns values, and reports hits through wrap()', async () => {
    const store = new CacheStore(await mkdtemp(join(tmpdir(), 'rc-cache-')))
    const key = store.key('ocr', 'doc', 3)
    expect(await store.get('ocr', key)).toBeUndefined()
    await store.set('ocr', key, { markdown: 'Merhaba' })
    expect(await store.get('ocr', key)).toEqual({ markdown: 'Merhaba' })

    let calls = 0
    const compute = async () => {
      calls++
      return 42
    }
    expect(await store.wrap('x', 'k', compute)).toEqual({ value: 42, hit: false })
    expect(await store.wrap('x', 'k', compute)).toEqual({ value: 42, hit: true })
    expect(calls).toBe(1)
  })

  it('treats corrupt entries as misses and deletes them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-cache-'))
    const store = new CacheStore(dir)
    const key = store.key('a')
    await store.set('ns', key, 1)
    const file = join(dir, 'ns', key.slice(0, 2), `${key}.json`)
    await writeFile(file, '{broken')
    expect(await store.get('ns', key)).toBeUndefined()
    expect(await readdir(join(dir, 'ns', key.slice(0, 2)))).toEqual([])
  })

  it('reports stats, prunes by age and clears', async () => {
    const store = new CacheStore(await mkdtemp(join(tmpdir(), 'rc-cache-')))
    await store.set('a', store.key(1), 'x')
    await store.set('b', store.key(2), 'y')
    const stats = await store.stats()
    expect(stats.entries).toBe(2)
    expect(Object.keys(stats.namespaces).sort()).toEqual(['a', 'b'])
    expect(await store.prune(60_000)).toBe(0)
    expect(await store.prune()).toBe(2)
    expect((await store.stats()).entries).toBe(0)
    await store.clear()
  })

  it('is a no-op when disabled', async () => {
    const store = new CacheStore(null)
    await store.set('a', 'k', 1)
    expect(await store.get('a', 'k')).toBeUndefined()
    expect((await store.stats()).entries).toBe(0)
    expect(store.enabled).toBe(false)
  })
})

describe('hash utilities', () => {
  it('stableStringify sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 0 }] } })).toBe(
      '{"a":{"c":[2,{"y":0,"z":1}]},"b":1}',
    )
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }))
  })
})

describe('async utilities', () => {
  it('mapPool keeps order and limits concurrency', async () => {
    let active = 0
    let peak = 0
    const out = await mapPool([5, 1, 3, 2, 4], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await sleep(n * 2)
      active--
      return n * 10
    })
    expect(out).toEqual([50, 10, 30, 20, 40])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('mapPool rethrows the first error and honours abort', async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(mapPool([1], 1, async (n) => n, ctrl.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(sleep(1000, ctrl.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('batches splits evenly', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(batches([], 3)).toEqual([])
  })
})
