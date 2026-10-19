import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/load.js'
import { MODELS } from '../../src/local/models.js'
import {
  cellAreas,
  cellBoxPixels,
  resolveTablePlan,
  STRUCTURE_MODELS,
  structureVocabulary,
  TABLE_CLASSIFIER,
  TABLE_DICT,
  tablePlanModels,
} from '../../src/local/table.js'

describe('table structure models', () => {
  it('follows layout.tables, then the environment, then the profile', () => {
    const full = resolveConfig({})
    const basic = resolveConfig({ local: { profile: 'basic' } })
    expect(resolveTablePlan(full, {})).toEqual({
      wired: 'slanext-wired',
      wireless: 'slanext-wireless',
      classify: true,
    })
    expect(resolveTablePlan(basic, {})).toEqual({
      wired: 'slanet-plus',
      wireless: 'slanet-plus',
      classify: false,
    })
    expect(resolveTablePlan(resolveConfig({ layout: { tables: 'slanet-plus' } }), {}).classify).toBe(false)
    expect(
      resolveTablePlan(resolveConfig({ local: { profile: 'basic' }, layout: { tables: 'slanext' } }), {})
        .wired,
    ).toBe('slanext-wired')
    expect(resolveTablePlan(full, { RAG_CHUNKER_TABLE_MODEL: 'slanet-plus' }).wired).toBe('slanet-plus')
    expect(resolveTablePlan(full, { RAG_CHUNKER_TABLE_WIRELESS: 'slanet-plus' }).wireless).toBe('slanet-plus')
    // An explicit choice beats the environment.
    expect(
      resolveTablePlan(resolveConfig({ layout: { tables: 'slanext' } }), {
        RAG_CHUNKER_TABLE_MODEL: 'slanet-plus',
      }).wired,
    ).toBe('slanext-wired')
    expect(() => resolveConfig({ layout: { tables: 'tablemaster' as 'auto' } })).toThrow()
  })

  it('lists the files a plan needs, each in the catalogue', () => {
    expect(tablePlanModels({ wired: 'slanet-plus', wireless: 'slanet-plus', classify: false })).toEqual([
      'slanet-plus',
      TABLE_DICT,
    ])
    const big = tablePlanModels({ wired: 'slanext-wired', wireless: 'slanext-wireless', classify: true })
    expect(big).toEqual(['slanext-wired', 'slanext-wireless', TABLE_DICT, TABLE_CLASSIFIER])
    for (const id of big) expect(MODELS[id].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(STRUCTURE_MODELS['slanext-wired'].input).toBe(512)
    expect(STRUCTURE_MODELS['slanet-plus'].input).toBe(488)
    expect(MODELS['slanext-wired'].bytes).toBeGreaterThan(MODELS['slanet-plus'].bytes * 40)
  })

  it('maps cell boxes from the padded square (SLANet_plus) or the table image (SLANeXt)', () => {
    // A table crop twice as wide as tall at (100, 50); a cell in the lower right quarter of the table.
    const crop = { x0: 100, y0: 50, w: 400, h: 200 }
    const xs = [0.5, 1, 1, 0.5]
    // SLANet_plus: y is relative to the 400 × 400 padded square, so the table's bottom is at 0.5.
    expect(cellBoxPixels(xs, [0.25, 0.25, 0.5, 0.5], crop, 'padded')).toEqual({
      x0: 300,
      x1: 500,
      y0: 150,
      y1: 250,
    })
    // SLANeXt: y is relative to the table image itself.
    expect(cellBoxPixels(xs, [0.5, 0.5, 1, 1], crop, 'image')).toEqual({ x0: 300, x1: 500, y0: 150, y1: 250 })
    expect(STRUCTURE_MODELS['slanext-wired'].boxes).toBe('image')
    expect(STRUCTURE_MODELS['slanet-plus'].boxes).toBe('padded')
  })

  it('widens content boxes to cell areas between the row and column midpoints', () => {
    // 2 × 2 table with a header cell spanning both columns; content boxes hug the text.
    const cells = [
      { row: 0, col: 0, rowSpan: 1, colSpan: 2 },
      { row: 1, col: 0, rowSpan: 1, colSpan: 1 },
      { row: 1, col: 1, rowSpan: 1, colSpan: 1 },
    ]
    const boxes = [
      { x0: 40, y0: 10, x1: 160, y1: 30 },
      { x0: 10, y0: 60, x1: 50, y1: 80 },
      { x0: 130, y0: 62, x1: 190, y1: 78 },
    ]
    const crop = { x0: 0, y0: 0, w: 200, h: 100 }
    expect(cellAreas(cells, boxes, 2, 2, crop)).toEqual([
      { x0: 0, x1: 200, y0: 0, y1: 45 },
      { x0: 0, x1: 90, y0: 45, y1: 100 },
      { x0: 90, x1: 200, y0: 45, y1: 100 },
    ])
    // A column without a single-column cell cannot be measured: the boxes stay as they are.
    expect(cellAreas(cells.slice(0, 1), boxes.slice(0, 1), 1, 2, crop)).toEqual(boxes.slice(0, 1))
  })

  it('decodes the 50 structure classes every SLANet model shares', () => {
    const dict = [
      '<thead>',
      '</thead>',
      '<tbody>',
      '</tbody>',
      '<tr>',
      '</tr>',
      '<td>',
      '<td',
      '>',
      '</td>',
      ...Array.from({ length: 19 }, (_, i) => ` colspan="${i + 2}"`),
      ...Array.from({ length: 19 }, (_, i) => ` rowspan="${i + 2}"`),
    ].join('\n')
    const vocabulary = structureVocabulary(dict)
    expect(vocabulary).toHaveLength(50)
    expect(vocabulary[0]).toBe('sos')
    expect(vocabulary.at(-2)).toBe('<td></td>')
    expect(vocabulary).not.toContain('<td>')
  })
})
