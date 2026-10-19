import { describe, expect, it } from 'vitest'
import { ocrItems } from '../../src/documents/pdf.js'
import { ctcDecode, type OcrResult, wordsFromChars } from '../../src/local/ocr.js'

describe('OCR word positions', () => {
  it('keeps the step of every decoded character', () => {
    // 4 classes: blank, "a", "b", " "; 6 steps: a a blank b space b → "ab b"
    const classes = 4
    const seq = [1, 1, 0, 2, 3, 2]
    const logits = seq.flatMap((c) => Array.from({ length: classes }, (_, k) => (k === c ? 5 : 0)))
    const out = ctcDecode(logits, seq.length, classes, ['', 'a', 'b', ' '])
    expect(out.text).toBe('ab b')
    expect(out.chars.map((c) => [c.char, c.step])).toEqual([
      ['a', 0],
      ['b', 3],
      [' ', 4],
      ['b', 5],
    ])
  })

  it('turns characters with steps into words with pixel ranges inside the line box', () => {
    // A 400 px wide line resized to 200 px for recognition; 20 steps → 10 px per step in the crop.
    const chars = [
      { char: 'A', step: 0, confidence: 0.9 },
      { char: 'd', step: 1, confidence: 0.9 },
      { char: ' ', step: 2, confidence: 0.9 },
      { char: 'S', step: 3, confidence: 0.8 },
      { char: 'o', step: 4, confidence: 0.8 },
      { char: 'y', step: 5, confidence: 0.8 },
      { char: ' ', step: 6, confidence: 0.8 },
      { char: ' ', step: 7, confidence: 0.8 },
      { char: '1', step: 18, confidence: 0.7 },
      { char: '2', step: 19, confidence: 0.7 },
    ]
    const words = wordsFromChars(chars, 20, { x0: 100, x1: 500 })
    expect(words.map((w) => w.text)).toEqual(['Ad', 'Soy', '12'])
    // Each step covers 400 / 20 = 20 px of the line: "Ad" spans steps 0-1 → 100-140.
    expect(words[0]).toMatchObject({ x0: 100, x1: 140 })
    expect(words[1]).toMatchObject({ x0: 160, x1: 220 })
    expect(words[2]).toMatchObject({ x0: 460, x1: 500 })
    expect(words[2]?.confidence).toBeCloseTo(0.7, 5)
  })

  it('keeps one text item per line and carries the words as parts', () => {
    const result: OcrResult = {
      width: 1000,
      height: 1000,
      lines: [
        {
          text: 'Ad Soy',
          x0: 100,
          y0: 100,
          x1: 300,
          y1: 120,
          confidence: 0.9,
          words: [
            { text: 'Ad', x0: 100, x1: 160, confidence: 0.95 },
            { text: 'Soy', x0: 200, x1: 300, confidence: 0.85 },
          ],
        },
        { text: 'Tek', x0: 100, y0: 200, x1: 150, y1: 220, confidence: 0.8 },
      ],
    }
    const items = ocrItems(result, { width: 500, height: 500 })
    expect(items.map((i) => [i.str, i.x, i.width, i.confidence])).toEqual([
      ['Ad Soy', 50, 100, 0.9],
      ['Tek', 50, 25, 0.8],
    ])
    expect(items[0]?.parts).toEqual([
      { str: 'Ad', x: 50, width: 30, confidence: 0.95 },
      { str: 'Soy', x: 100, width: 50, confidence: 0.85 },
    ])
    expect(items[1]?.parts).toBeUndefined()
  })

  it('snaps line heights close to the body height so detector noise does not make headings', () => {
    const line = (y0: number, h: number, text: string) => ({
      text,
      x0: 10,
      y0,
      x1: 900,
      y1: y0 + h,
      confidence: 0.9,
    })
    const body = 'a line of ordinary body text, long enough'
    const result: OcrResult = {
      width: 1000,
      height: 1000,
      lines: [
        line(0, 50, 'A REAL HEADING'),
        line(100, 21, body),
        line(130, 25, body),
        line(160, 21, body),
        line(190, 25, body),
        line(220, 21, body),
        line(250, 29, body),
        line(300, 12, 'tiny footnote text that stays small enough'),
      ],
    }
    const sizes = ocrItems(result, { width: 1000, height: 1000 }).map((i) => Number(i.size.toFixed(2)))
    expect(sizes[0]).toBeCloseTo(50 / 1.05, 2)
    expect(new Set(sizes.slice(1, 6)).size).toBe(1)
    expect(sizes[6]).toBeCloseTo(29 / 1.05, 2)
    expect(sizes[7]).toBeCloseTo(12 / 1.05, 2)
  })
})
