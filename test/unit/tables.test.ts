import { describe, expect, it } from 'vitest'
import { detectTables, type TextPiece, tableFromModel } from '../../src/documents/tables.js'
import { decodeStructure, structureToGrid, structureVocabulary } from '../../src/local/table.js'

describe('table structure model decoding', () => {
  it('builds the vocabulary the way SLANet decodes it', () => {
    const vocab = structureVocabulary(
      '<thead>\n</thead>\n<tr>\n</tr>\n<td>\n<td\n>\n</td>\n colspan="2"\n rowspan="2"\n',
    )
    expect(vocab).toEqual([
      'sos',
      '<thead>',
      '</thead>',
      '<tr>',
      '</tr>',
      '<td',
      '>',
      '</td>',
      ' colspan="2"',
      ' rowspan="2"',
      '<td></td>',
      'eos',
    ])
  })

  it('decodes tokens until eos and remembers the steps that carry a cell box', () => {
    const vocab = ['sos', '<tr>', '</tr>', '<td', '>', '</td>', ' colspan="2"', '<td></td>', 'eos']
    const seq = ['sos', '<tr>', '<td></td>', '<td', ' colspan="2"', '>', '</td>', '</tr>', 'eos', '<tr>']
    const probs = seq.flatMap((tok) => vocab.map((v) => (v === tok ? 1 : 0)))
    const { tokens, cellSteps } = decodeStructure(probs, seq.length, vocab.length, vocab)
    expect(tokens).toEqual(['<tr>', '<td></td>', '<td', ' colspan="2"', '>', '</td>', '</tr>'])
    expect(cellSteps).toEqual([2, 3])
  })

  it('lays cells out on a grid with spans blocking the rows below', () => {
    const tokens = [
      '<thead>',
      '<tr>',
      '<td',
      ' rowspan="2"',
      '>',
      '</td>',
      '<td',
      ' colspan="2"',
      '>',
      '</td>',
      '</tr>',
      '<tr>',
      '<td></td>',
      '<td></td>',
      '</tr>',
      '</thead>',
      '<tbody>',
      '<tr>',
      '<td></td>',
      '<td></td>',
      '<td></td>',
      '</tr>',
      '</tbody>',
    ]
    const grid = structureToGrid(tokens)
    expect(grid).toMatchObject({ rows: 3, cols: 3, headerRows: 2 })
    expect(grid.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan])).toEqual([
      [0, 0, 2, 1],
      [0, 1, 1, 2],
      [1, 1, 1, 1],
      [1, 2, 1, 1],
      [2, 0, 1, 1],
      [2, 1, 1, 1],
      [2, 2, 1, 1],
    ])
  })
})

describe('detectTables with a structure-model table', () => {
  const piece = (text: string, x0: number, y: number, x1?: number): TextPiece => ({
    text,
    x0,
    x1: x1 ?? x0 + text.length * 5,
    y,
    size: 10,
    items: [{ str: text, x: x0, width: (x1 ?? x0 + text.length * 5) - x0, size: 10 }],
  })

  it('distributes the page text into the model cells, with spans, and keeps other text', () => {
    // Two header rows (first cell spans both), two body rows, three columns; y grows upwards.
    const col = (c: number) => ({ x0: 50 + c * 100, x1: 150 + c * 100 })
    const row = (r: number) => ({ y0: 700 - r * 20 - 20, y1: 700 - r * 20 })
    const cells = [
      { row: 0, col: 0, rowSpan: 2, colSpan: 1, bbox: { ...col(0), y0: row(1).y0, y1: row(0).y1 } },
      { row: 0, col: 1, rowSpan: 1, colSpan: 2, bbox: { x0: col(1).x0, x1: col(2).x1, ...row(0) } },
      { row: 1, col: 1, rowSpan: 1, colSpan: 1, bbox: { ...col(1), ...row(1) } },
      { row: 1, col: 2, rowSpan: 1, colSpan: 1, bbox: { ...col(2), ...row(1) } },
      ...[2, 3].flatMap((r) =>
        [0, 1, 2].map((c) => ({ row: r, col: c, rowSpan: 1, colSpan: 1, bbox: { ...col(c), ...row(r) } })),
      ),
    ]
    const model = {
      rows: 4,
      cols: 3,
      headerRows: 1,
      cells,
      region: { x0: 50, x1: 350, y0: row(3).y0, y1: row(0).y1 },
    }
    const pieces = [
      piece('Başlık', 50, 720),
      piece('Ad', 55, 675),
      piece('Değerler', 160, 688),
      piece('Alt', 155, 668),
      piece('Üst', 255, 668),
      piece('A', 55, 648),
      piece('2', 255, 648),
      piece('B', 55, 628),
      piece('4', 255, 628),
      piece('Sonraki paragraf burada devam eder.', 50, 580),
    ]
    const { tables, remaining } = detectTables(
      pieces,
      { h: [], v: [] },
      { width: 600, hints: [model.region], models: [model] },
    )
    expect(tables).toHaveLength(1)
    const t = (tables[0] as (typeof tables)[number]).data
    expect(t).toMatchObject({ source: 'model', rows: 4, cols: 3, headerRows: 2 })
    const text = (r: number, c: number) => t.cells.find((x) => x.row === r && x.col === c)?.text
    expect(text(0, 0)).toBe('Ad')
    expect(text(0, 1)).toBe('Değerler')
    expect(text(1, 2)).toBe('Üst')
    expect(text(2, 1)).toBe('')
    expect(text(3, 2)).toBe('4')
    expect(remaining.map((p) => p.text)).toEqual(['Başlık', 'Sonraki paragraf burada devam eder.'])
  })

  it('keeps a wrapped line with its row when the model boundary drifts into a paragraph', () => {
    // Two rows, two columns. The right cell of row 0 has three lines (pitch 12); the model draws
    // the row boundary one line too high, so the third line falls in the band of row 1.
    const cell = (row: number, col: number, y0: number, y1: number) => ({
      row,
      col,
      rowSpan: 1,
      colSpan: 1,
      bbox: { x0: col === 0 ? 50 : 145, x1: col === 0 ? 145 : 400, y0, y1 },
    })
    const model = {
      rows: 2,
      cols: 2,
      headerRows: 0,
      cells: [cell(0, 0, 672, 700), cell(0, 1, 672, 700), cell(1, 0, 640, 672), cell(1, 1, 640, 672)],
      region: { x0: 50, x1: 400, y0: 640, y1: 700 },
    }
    const pieces = [
      piece('Soru:', 55, 690),
      piece('satır bir', 150, 690),
      piece('satır iki', 150, 678),
      piece('satır üç', 150, 666),
      piece('Yanıt:', 55, 648),
      piece('devam', 150, 648),
    ]
    const built = tableFromModel(model, pieces)
    expect(built).not.toBeNull()
    const text = (r: number, c: number) =>
      built?.table.data.cells.find((x) => x.row === r && x.col === c)?.text
    expect(text(0, 1)).toBe('satır bir satır iki satır üç')
    expect(text(1, 0)).toBe('Yanıt:')
    expect(text(1, 1)).toBe('devam')
    expect(built?.used.size).toBe(6)
  })

  it('drops empty columns and rejects what is then a list, stacked rows and cut prose', () => {
    const grid = (rows: number, cols: number, x0: number, w: number, top: number, h: number) => ({
      rows,
      cols,
      headerRows: 1,
      cells: Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => ({
          row: r,
          col: c,
          rowSpan: 1,
          colSpan: 1,
          bbox: { x0: x0 + c * w, x1: x0 + (c + 1) * w, y0: top - (r + 1) * h, y1: top - r * h },
        })),
      ).flat(),
      region: { x0, x1: x0 + cols * w, y0: top - rows * h, y1: top },
    })
    // A bullet list seen as a two-column table: the second column never gets text.
    const list = tableFromModel(
      grid(4, 2, 50, 150, 700, 20),
      [0, 1, 2, 3].map((r) => piece(`► madde ${r + 1}`, 55, 685 - r * 20)),
    )
    expect(list).toBeNull()
    // Three columns of which the middle one is empty: it is dropped and the cells move left.
    const sparse = tableFromModel(grid(3, 3, 50, 100, 700, 20), [
      ...[0, 1, 2].map((r) => piece(`a${r}`, 55, 685 - r * 20)),
      ...[0, 1, 2].map((r) => piece(`c${r}`, 255, 685 - r * 20)),
    ])
    expect(sparse?.table.data).toMatchObject({ rows: 3, cols: 2 })
    expect(sparse?.table.data.cells.map((c) => [c.row, c.col, c.text])).toEqual([
      [0, 0, 'a0'],
      [0, 1, 'c0'],
      [1, 0, 'a1'],
      [1, 1, 'c1'],
      [2, 0, 'a2'],
      [2, 1, 'c2'],
    ])
    // The model merged pairs of rows: every cell holds two short tokens from two lines.
    const stacked = tableFromModel(
      grid(2, 3, 50, 100, 700, 40),
      [0, 1, 2, 3].flatMap((line) =>
        [0, 1, 2].map((c) => piece(`${line}${c}.5`, 55 + c * 100, 690 - line * 20)),
      ),
    )
    expect(stacked).toBeNull()
    // Justified prose split at wide word gaps: the parts run past the model's narrow cells.
    const prose = tableFromModel(
      grid(3, 2, 50, 100, 700, 20),
      [0, 1, 2].map((r) =>
        piece(
          `bu uzun cümle hücre sınırını aşarak  devam eder ve sütun kutusuna sığmaz`,
          55,
          685 - r * 20,
          345,
        ),
      ),
    )
    expect(prose).toBeNull()
  })

  it('takes rows from the text lines when asked and the counts agree', () => {
    // Three single-line rows at y 690/678/666; the model's row boxes drift so that by bands the
    // first two lines share row 0 (merged rows, rejected). With `lineRows` only the columns count.
    const bands = [
      { y0: 680, y1: 700 },
      { y0: 668, y1: 680 },
      { y0: 650, y1: 668 },
    ]
    const cells = [0, 1, 2].flatMap((r) =>
      [0, 1].map((c) => ({
        row: r,
        col: c,
        rowSpan: 1,
        colSpan: 1,
        bbox: { x0: 50 + c * 100, x1: 150 + c * 100, ...(bands[r] as { y0: number; y1: number }) },
      })),
    )
    const model = { rows: 3, cols: 2, headerRows: 1, cells, region: { x0: 50, x1: 250, y0: 650, y1: 700 } }
    const pieces = [0, 1, 2].flatMap((r) => [
      piece(`s${r}`, 55, 690 - r * 12),
      piece(`${r}.0`, 155, 690 - r * 12),
    ])
    expect(tableFromModel(model, pieces)).toBeNull()
    const byLines = tableFromModel(model, pieces, { lineRows: true })
    expect(byLines?.stacked).toBe(0)
    expect(byLines?.table.data.cells.map((c) => c.text)).toEqual(['s0', '0.0', 's1', '1.0', 's2', '2.0'])
  })

  it('ignores a model table that explains almost none of the text', () => {
    const model = {
      rows: 2,
      cols: 2,
      headerRows: 1,
      cells: [0, 1].flatMap((r) =>
        [0, 1].map((c) => ({
          row: r,
          col: c,
          rowSpan: 1,
          colSpan: 1,
          bbox: { x0: 400 + c * 50, x1: 450 + c * 50, y0: 100 + r * 20, y1: 120 + r * 20 },
        })),
      ),
      region: { x0: 400, x1: 500, y0: 100, y1: 140 },
    }
    const pieces = [piece('Metin', 50, 700), piece('Devam', 50, 680)]
    const { tables, remaining } = detectTables(
      pieces,
      { h: [], v: [] },
      { width: 600, hints: [model.region], models: [model] },
    )
    expect(tables).toHaveLength(0)
    expect(remaining).toHaveLength(2)
  })
})
