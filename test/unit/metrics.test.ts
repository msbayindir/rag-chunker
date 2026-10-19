import { describe, expect, it } from 'vitest'
import {
  cellText,
  coverage,
  htmlTableToData,
  iou,
  latexToText,
  levenshtein,
  markdownToPlainText,
  normalizedEditDistance,
  officialNormalize,
  readingOrderDistance,
  sequenceEditDistance,
} from '../../src/eval/metrics.js'
import { teds } from '../../src/eval/teds.js'

describe('text metrics', () => {
  it('computes edit distances on strings and sequences', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(normalizedEditDistance('abcd', 'abcd')).toBe(0)
    expect(normalizedEditDistance('abcd', 'abxd')).toBe(0.25)
    expect(normalizedEditDistance('', '')).toBe(0)
    expect(sequenceEditDistance([1, 2, 3], [1, 3])).toBe(1)
  })

  it('scores reading order as the distance from the sorted sequence', () => {
    expect(readingOrderDistance([0, 1, 2, 3])).toBe(0)
    expect(readingOrderDistance([1, 0, 2, 3])).toBe(0.5) // one swap = two edits over four blocks
    expect(readingOrderDistance([3, 2, 1, 0])).toBeGreaterThan(0.5)
    expect(readingOrderDistance([7])).toBe(0)
  })

  it('turns page markdown into plain text without tables, images and markup', () => {
    const md =
      '# Başlık\n\nBir **kalın** ve *eğik* cümle [bağlantı](http://x) ile.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![Şekil 1](figures/p1-1.png)\n\n- madde bir\n- madde iki\n\n```js\ncode\n```\n'
    expect(markdownToPlainText(md)).toBe(
      'Başlık Bir kalın ve eğik cümle bağlantı ile. madde bir madde iki code',
    )
  })
})

describe('OmniDocBench text normalisation', () => {
  // Expected strings come from pylatexenc 2.10's LatexNodes2Text, which the official scorer uses.
  it('renders inline LaTeX the way pylatexenc does', () => {
    expect(latexToText('d_1 \\le d_2 \\le \\dots \\le d_{12}')).toBe('d_1 ≤d_2 ≤…≤d_12')
    expect(latexToText('\\frac{a}{b} + \\sqrt{\\epsilon} + \\sqrt[3]{x}')).toBe('a/b + √(ϵ) + √(x)')
    expect(latexToText('\\left( \\frac{1}{2} \\right)')).toBe('( 1/2 )')
    expect(latexToText('\\alpha\\beta\\Gamma \\infty \\to \\rightarrow \\partial')).toBe('αβΓ∞→→∂')
    expect(latexToText('\\operatorname{sin}(x) \\mathrm{d}x')).toBe('sin(x) dx')
    expect(latexToText('\\foo{bar} \\unknowncmd x')).toBe('bar x')
    expect(latexToText('\\mathcal{L} \\mathbb{R}^n')).toBe('ℒ ℝ^n')
    expect(latexToText('\\mathbf{x}_i \\cdot \\boldsymbol{\\beta}')).toBe('𝐱_i ·β')
    expect(latexToText('100\\% \\& a\\_b')).toBe('100% & a_b')
    expect(latexToText('\\sum_{i=1}^{n} x_i')).toBe('∑_i=1^n x_i')
    expect(latexToText('\\overline{\\partial} \\lambda_\\nu')).toBe('∂ λ_ν')
    expect(latexToText('\\mathrm{H}_2\\mathrm{O}')).toBe('H_2O')
    expect(latexToText('\\times 10^{-3}')).toBe('×10^-3')
  })

  it('keeps letters, digits and underscores only, with inline formulas rendered first', () => {
    expect(officialNormalize('Remark. With slightly more work, one can show that $S$ forms a group')).toBe(
      'RemarkWithslightlymoreworkonecanshowthatSformsagroup',
    )
    expect(officialNormalize('assume $d_1 \\le d_2 \\le \\dots \\le d_{12}$.')).toBe('assumed_1d_2d_12')
    expect(officialNormalize('assume d1 ≤ d2 ≤ ··· ≤ d12.')).toBe('assumed1d2d12')
    expect(officialNormalize('Water (H\\(_2\\)O) at 20 °C')).toBe('WaterH_2Oat20C')
    expect(officialNormalize('Türkçe İ ç ş — ①②')).toBe('Türkçeİçş12')
    expect(officialNormalize('a\\nb\\tc')).toBe('abc')
  })
})

describe('reference tables from HTML', () => {
  it('reads cells, spans and header rows and cleans cell text', () => {
    const t = htmlTableToData(
      '<table><thead><tr><th rowspan="2">Model</th><th colspan=2>Dev</th></tr><tr><th>EM</th><th>F1</th></tr></thead><tbody><tr><td>BERT</td><td>$84.1$</td><td>90.9 &amp; up</td></tr></tbody></table>',
    )
    expect(t).toMatchObject({ rows: 3, cols: 3, headerRows: 2 })
    expect(t?.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.text])).toEqual([
      [0, 0, 2, 1, 'Model'],
      [0, 1, 1, 2, 'Dev'],
      [1, 1, 1, 1, 'EM'],
      [1, 2, 1, 1, 'F1'],
      [2, 0, 1, 1, 'BERT'],
      [2, 1, 1, 1, '84.1'],
      [2, 2, 1, 1, '90.9 & up'],
    ])
    expect(htmlTableToData('<table></table>')).toBeNull()
    expect(cellText('<b>$d_{w}$</b><br/>x')).toBe('d_w x')
  })

  it('agrees with itself under TEDS and tells a wrong structure apart', () => {
    const ref = htmlTableToData('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')
    const same = htmlTableToData('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')
    const merged = htmlTableToData(
      '<table><tr><td colspan="2">a b</td></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    if (!ref || !same || !merged) throw new Error('tables expected')
    expect(teds(same, ref)).toBe(1)
    expect(teds(merged, ref)).toBeLessThan(1)
    expect(teds(merged, ref, { structureOnly: true })).toBeLessThan(1)
  })
})

describe('boxes', () => {
  it('computes IoU and coverage', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    const b = { x: 5, y: 0, w: 10, h: 10 }
    expect(iou(a, b)).toBeCloseTo(50 / 150, 6)
    expect(coverage({ x: 2, y: 2, w: 4, h: 4 }, a)).toBe(1)
    expect(iou(a, { x: 20, y: 20, w: 1, h: 1 })).toBe(0)
  })
})
