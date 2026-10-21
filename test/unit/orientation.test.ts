import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CacheStore } from '../../src/cache/store.js'
import type { PageLike } from '../../src/local/layout.js'
import {
  decideRotation,
  type OrientationResult,
  orientPages,
  type Rotation,
  turnUpright,
} from '../../src/local/orientation.js'

const canvas = await import('@napi-rs/canvas').catch(() => null)

/** A W×H image with a dark square in its top-left corner, as PNG bytes and as RGBA. */
function marked(width: number, height: number): { png: Uint8Array; rgba: Uint8ClampedArray } {
  if (!canvas) throw new Error('canvas missing')
  const c = canvas.createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 4, 4)
  return { png: new Uint8Array(c.toBuffer('image/png')), rgba: ctx.getImageData(0, 0, width, height).data }
}

/** Ground truth: turns RGBA pixels clockwise by 90, 180 or 270 degrees with plain index arithmetic. */
function turnClockwise(rgba: Uint8ClampedArray, width: number, height: number, angle: Rotation) {
  const outW = angle === 180 ? width : height
  const outH = angle === 180 ? height : width
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number
      let ny: number
      if (angle === 90) [nx, ny] = [height - 1 - y, x]
      else if (angle === 180) [nx, ny] = [width - 1 - x, height - 1 - y]
      else [nx, ny] = [y, width - 1 - x]
      for (let c = 0; c < 4; c++) out[(ny * outW + nx) * 4 + c] = rgba[(y * width + x) * 4 + c] as number
    }
  }
  return { rgba: out, width: outW, height: outH }
}

async function pngOf(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  if (!canvas) throw new Error('canvas missing')
  const c = canvas.createCanvas(width, height)
  const ctx = c.getContext('2d')
  const image = ctx.createImageData(width, height)
  image.data.set(rgba)
  ctx.putImageData(image, 0, 0)
  return new Uint8Array(c.toBuffer('image/png'))
}

async function decode(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  if (!canvas) throw new Error('canvas missing')
  const img = await canvas.loadImage(Buffer.from(png))
  const c = canvas.createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return { width: img.width, height: img.height, rgba: ctx.getImageData(0, 0, img.width, img.height).data }
}

describe('decideRotation', () => {
  it('returns the winning class when its score reaches the threshold', () => {
    expect(decideRotation([0.03, 0.02, 0.05, 0.9])).toEqual({ rotation: 270, score: 0.9 })
    expect(decideRotation([0.93, 0.03, 0.02, 0.02])).toEqual({ rotation: 0, score: 0.93 })
  })
  it('leaves the page alone below the threshold, keeping the score for the record', () => {
    expect(decideRotation([0.22, 0.7, 0.04, 0.04])).toEqual({ rotation: 0, score: 0.7 })
    expect(decideRotation([0.22, 0.7, 0.04, 0.04], 0.6)).toEqual({ rotation: 90, score: 0.7 })
    expect(decideRotation([0.2, 0.76, 0.02, 0.02])).toEqual({ rotation: 90, score: 0.76 })
    expect(decideRotation([])).toEqual({ rotation: 0, score: 0 })
  })
  it('asks more of a 180 call, where upright forms score up to 0.86', () => {
    expect(decideRotation([0.05, 0.05, 0.86, 0.04])).toEqual({ rotation: 0, score: 0.86 })
    expect(decideRotation([0.02, 0.02, 0.94, 0.02])).toEqual({ rotation: 180, score: 0.94 })
    expect(decideRotation([0.05, 0.05, 0.86, 0.04], 0.5)).toEqual({ rotation: 0, score: 0.86 })
  })
})

describe.skipIf(!canvas)('turnUpright', () => {
  it('undoes a clockwise turn of 90, 180 and 270 degrees pixel for pixel', async () => {
    const width = 9
    const height = 6
    const source = marked(width, height)
    for (const angle of [90, 180, 270] as const) {
      const turned = turnClockwise(source.rgba, width, height, angle)
      const back = await decode(
        await turnUpright(await pngOf(turned.rgba, turned.width, turned.height), angle),
      )
      expect([back.width, back.height]).toEqual([width, height])
      expect(Array.from(back.rgba)).toEqual(Array.from(source.rgba))
    }
  })
  it('returns the bytes unchanged for an upright page', async () => {
    const { png } = marked(5, 5)
    expect(await turnUpright(png, 0)).toBe(png)
  })
})

describe.skipIf(!canvas)('orientPages', () => {
  const fakeDoc = (calls: string[]): PageLike => ({
    pageCount: 2,
    renderPng: async (n, longSide) => {
      calls.push(`render ${n} ${longSide ?? '-'}`)
      return marked(30, 20).png
    },
    pageSize: async () => ({ width: 300, height: 200 }),
  })
  const classifier =
    (log: number[], result: (png: Uint8Array) => OrientationResult) => async (png: Uint8Array) => {
      log.push(png.length)
      return result(png)
    }

  it('turns a page after orient() said so and leaves the others alone', async () => {
    const calls: string[] = []
    const classified: number[] = []
    let page = 0
    const pages = orientPages(
      fakeDoc(calls),
      classifier(classified, () =>
        page === 1 ? { rotation: 90, score: 0.95 } : { rotation: 0, score: 0.9 },
      ),
    )
    expect(pages.pageCount).toBe(2)
    // Nothing is classified until a page is sent to OCR.
    expect(await pages.pageSize(1)).toEqual({ width: 300, height: 200 })
    expect(classified).toHaveLength(0)

    page = 1
    expect(await pages.orient(1)).toEqual({ rotation: 90, score: 0.95 })
    expect(pages.rotation?.(1)).toBe(90)
    expect(await pages.pageSize(1)).toEqual({ width: 200, height: 300 })
    const turned = await decode(await pages.renderPng(1, 1024))
    expect([turned.width, turned.height]).toEqual([20, 30])

    page = 2
    expect(await pages.orient(2)).toEqual({ rotation: 0, score: 0.9 })
    expect(pages.rotation?.(2)).toBe(0)
    expect(await pages.pageSize(2)).toEqual({ width: 300, height: 200 })
    expect(await decode(await pages.renderPng(2, 1024))).toMatchObject({ width: 30, height: 20 })

    // One classification per page, on a small render, however often the page is asked for.
    await pages.orient(1)
    expect(classified).toHaveLength(2)
    expect(calls.filter((c) => c.startsWith('render 1 '))).toEqual(['render 1 640', 'render 1 1024'])
  })

  it('remembers the decision in the cache per document page', async () => {
    const cache = new CacheStore(await mkdtemp(join(tmpdir(), 'rc-orient-')))
    const classified: number[] = []
    const classify = classifier(classified, () => ({ rotation: 270, score: 0.88 }))
    const first = orientPages(fakeDoc([]), classify, { cache, documentId: 'doc-a' })
    expect(await first.orient(1)).toEqual({ rotation: 270, score: 0.88 })
    const second = orientPages(fakeDoc([]), classify, { cache, documentId: 'doc-a' })
    expect(await second.orient(1)).toEqual({ rotation: 270, score: 0.88 })
    expect(await second.pageSize(1)).toEqual({ width: 200, height: 300 })
    const other = orientPages(fakeDoc([]), classify, { cache, documentId: 'doc-b' })
    await other.orient(1)
    expect(classified).toHaveLength(2)
  })
})
