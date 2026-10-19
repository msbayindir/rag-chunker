import { describe, expect, it } from 'vitest'
import { formulasOnPage } from '../../src/documents/pdf.js'
import { cleanLatex, FORMULA_MODELS } from '../../src/local/formula.js'
import type { LayoutRegion } from '../../src/local/layout.js'
import { MODELS } from '../../src/local/models.js'

describe('formula recognition', () => {
  it('cleans the model output into a LaTeX body and rejects prose', () => {
    expect(cleanLatex('$$\\frac{a}{b} = c$$')).toBe('\\frac{a}{b} = c')
    expect(cleanLatex('$x^2 + y^2 = z^2$')).toBe('x^2 + y^2 = z^2')
    expect(cleanLatex('\\[ \\int_0^1 f(x)\\,dx \\]')).toBe('\\int_0^1 f(x)\\,dx')
    expect(cleanLatex('  E = mc^2 \n')).toBe('E = mc^2')
    expect(cleanLatex('(15) $a_{k}=f[x_{0},x_{1},\\ldots,x_{k}]$.')).toBe(
      'a_{k}=f[x_{0},x_{1},\\ldots,x_{k}]',
    )
    expect(cleanLatex('$$f(x_{2})=P_{2}(x_{2})$.$$')).toBe('f(x_{2})=P_{2}(x_{2})')
    expect(cleanLatex('\\$5 + x = 7')).toBe('\\$5 + x = 7')
    expect(cleanLatex('')).toBeNull()
    expect(cleanLatex('$$$$')).toBeNull()
    expect(cleanLatex('## 6 Conclusion In this paper we have presented a method that works')).toBeNull()
    expect(cleanLatex('Table of contents and other words without any mathematics here')).toBeNull()
  })

  it('lists catalogue entries for every texify2 file', () => {
    for (const id of FORMULA_MODELS) expect(MODELS[id].file.startsWith('texify2/')).toBe(true)
    expect(MODELS['texify2-decoder'].bytes).toBeGreaterThan(MODELS['texify2-encoder'].bytes)
  })

  it('replaces confident formula regions with $$ lines and marks the text inside them', async () => {
    const regions: LayoutRegion[] = [
      { label: 'display_formula', score: 0.9, bbox: { x0: 100, y0: 500, x1: 400, y1: 560 }, order: 3 },
      { label: 'display_formula', score: 0.3, bbox: { x0: 100, y0: 300, x1: 400, y1: 340 }, order: 5 },
      { label: 'text', score: 0.95, bbox: { x0: 100, y0: 600, x1: 400, y1: 700 }, order: 2 },
    ]
    const page = { width: 600, height: 800 }
    const line = (y: number) => ({ text: 'x', y, x0: 120, x1: 380, size: 10, font: '', fontShare: 1 })
    const asked: string[] = []
    const result = await formulasOnPage(regions, page, [line(520), line(620)], async (r) => {
      asked.push(`${r.x0},${r.y0}`)
      return 'a^2 + b^2 = c^2'
    })
    expect(asked).toEqual(['100,500'])
    expect(result?.lines.map((l) => [l.text, l.formula, l.order, l.standalone, l.plain])).toEqual([
      ['$$a^2 + b^2 = c^2$$', 'a^2 + b^2 = c^2', 3, true, true],
    ])
    expect(result?.inside(line(520))).toBe(true)
    expect(result?.inside(line(620))).toBe(false)
    expect(await formulasOnPage(regions, page, [], async () => null)).toBeUndefined()
    expect(await formulasOnPage(null, page, [], async () => 'x')).toBeUndefined()
  })

  it('leaves alone formula regions that would swallow a block of text', async () => {
    const page = { width: 600, height: 800 }
    const line = (y: number) => ({ text: 'x', y, x0: 120, x1: 380, size: 10, font: '', fontShare: 1 })
    const huge: LayoutRegion[] = [
      { label: 'display_formula', score: 0.9, bbox: { x0: 50, y0: 100, x1: 550, y1: 700 }, order: 1 },
    ]
    expect(await formulasOnPage(huge, page, [line(300)], async () => 'x = 1')).toBeUndefined()
    const crowded: LayoutRegion[] = [
      { label: 'display_formula', score: 0.9, bbox: { x0: 100, y0: 400, x1: 400, y1: 560 }, order: 1 },
    ]
    const nine = Array.from({ length: 9 }, (_, i) => line(410 + i * 16))
    expect(await formulasOnPage(crowded, page, nine, async () => 'x = 1')).toBeUndefined()
    expect((await formulasOnPage(crowded, page, nine.slice(0, 4), async () => 'x = 1'))?.lines.length).toBe(1)
  })
})
