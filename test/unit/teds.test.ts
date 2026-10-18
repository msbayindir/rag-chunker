import { describe, expect, it } from 'vitest'
import type { TableData } from '../../src/documents/tables.js'
import { tableToHtml, tableToMarkdown } from '../../src/documents/tables.js'
import { tableTree, teds, treeEditDistance } from '../../src/eval/teds.js'

const table = (rows: string[][], headerRows = 1): TableData => ({
  rows: rows.length,
  cols: rows[0]?.length ?? 0,
  headerRows,
  source: 'ruled',
  cells: rows.flatMap((r, row) => r.map((text, col) => ({ row, col, rowSpan: 1, colSpan: 1, text }))),
})

describe('TEDS', () => {
  const gold = table([
    ['Ad', 'Boy', 'Puan'],
    ['Llama', '7B', '45,3'],
    ['Qwen', '9B', '51,0'],
  ])

  it('is 1 for identical tables and falls with every difference', () => {
    expect(teds(gold, gold)).toBe(1)
    const typo = table([
      ['Ad', 'Boy', 'Puan'],
      ['Llama', '7B', '45,8'],
      ['Qwen', '9B', '51,0'],
    ])
    expect(teds(typo, gold)).toBeGreaterThan(0.95)
    expect(teds(typo, gold)).toBeLessThan(1)
    expect(teds(typo, gold, { structureOnly: true })).toBe(1)
    const missingRow = table([
      ['Ad', 'Boy', 'Puan'],
      ['Llama', '7B', '45,3'],
    ])
    expect(teds(missingRow, gold)).toBeLessThan(0.8)
    const extraColumn = table([
      ['Ad', 'Boy', 'Puan', 'Yıl'],
      ['Llama', '7B', '45,3', '2023'],
      ['Qwen', '9B', '51,0', '2025'],
    ])
    expect(teds(extraColumn, gold)).toBeLessThan(teds(typo, gold))
  })

  it('counts spans as structure', () => {
    const spanned: TableData = {
      ...gold,
      cells: gold.cells
        .map((c) => (c.row === 0 && c.col === 1 ? { ...c, colSpan: 2 } : c))
        .filter((c) => !(c.row === 0 && c.col === 2)),
    }
    expect(teds(spanned, gold, { structureOnly: true })).toBeLessThan(1)
    expect(treeEditDistance(tableTree(gold), tableTree(gold))).toBe(0)
  })

  it('renders markdown and HTML with spans', () => {
    const t: TableData = {
      rows: 3,
      cols: 3,
      headerRows: 2,
      source: 'ruled',
      cells: [
        { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: 'Ad' },
        { row: 0, col: 1, rowSpan: 1, colSpan: 2, text: 'Değerler' },
        { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: 'Alt' },
        { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: 'Üst | üst' },
        { row: 2, col: 0, rowSpan: 1, colSpan: 1, text: 'A' },
        { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: '1' },
        { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: '2' },
      ],
    }
    expect(tableToMarkdown(t)).toBe('| Ad | Değerler Alt | Üst \\| üst |\n| --- | --- | --- |\n| A | 1 | 2 |')
    expect(tableToHtml(t)).toBe(
      '<table><thead><tr><th rowspan="2">Ad</th><th colspan="2">Değerler</th></tr><tr><th>Alt</th><th>Üst | üst</th></tr></thead><tbody><tr><td>A</td><td>1</td><td>2</td></tr></tbody></table>',
    )
  })
})
