import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, mainContent } from '../../src/documents/html.js'
import { detectKind } from '../../src/documents/input.js'
import {
  columnIndex,
  formatNumber,
  isDateFormat,
  serialToIso,
  xlsxToMarkdown,
} from '../../src/documents/xlsx.js'
import { RagChunkerError } from '../../src/errors.js'
import { splitPages } from '../../src/ocr/postprocess.js'
import { HTML, XLSX } from '../fixtures/content.js'
import { fixture } from '../fixtures/generate.js'

const bytes = async (name: string) => new Uint8Array(await readFile(fixture(name)))

describe('XLSX input', () => {
  it('detects workbooks and HTML pages', async () => {
    expect(detectKind(await bytes('sample.xlsx'), 'a').kind).toBe('xlsx')
    expect(detectKind(await bytes('sample.html'), 'page.txt').kind).toBe('html')
    expect(detectKind(new TextEncoder().encode('<p>fragment</p>'), 'frag.htm').kind).toBe('html')
    expect(detectKind(new TextEncoder().encode('# not html'), 'notes.txt').kind).toBe('markdown')
  })

  it('maps cell references, number formats, serial dates and float noise', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('Z9')).toBe(25)
    expect(columnIndex('AA10')).toBe(26)
    expect(isDateFormat('dd/mm/yyyy')).toBe(true)
    expect(isDateFormat('[$-409]d-mmm-yy;@')).toBe(true)
    expect(isDateFormat('0.00 "m"')).toBe(false)
    expect(isDateFormat('General')).toBe(false)
    expect(isDateFormat('#,##0.00')).toBe(false)
    expect(serialToIso(46037)).toBe('2026-01-15')
    expect(serialToIso(46037.5, { time: true })).toBe('2026-01-15 12:00')
    expect(serialToIso(0.75, { time: true })).toBe('18:00')
    expect(serialToIso(60, { date1904: true })).toBe('1904-03-01')
    expect(formatNumber('12.000000000000002')).toBe('12')
    expect(formatNumber('0.30000000000000004')).toBe('0.3')
    expect(formatNumber('1e21')).toBe('1e+21')
  })

  it('turns every visible sheet into a page with titles, tables, lists and resolved values', async () => {
    const { markdown, sheetCount, warnings } = await xlsxToMarkdown(await bytes('sample.xlsx'))
    expect(sheetCount).toBe(2)
    expect(warnings).toEqual([`XLSX: hidden sheet "${XLSX.hidden}" skipped`])
    const pages = splitPages(markdown)
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2])
    const sheet1 = pages[0]?.markdown ?? ''
    expect(sheet1.startsWith(`## ${XLSX.sheet1}`)).toBe(true)
    // The merged title cell is a paragraph, not a one-row table.
    expect(sheet1).toContain(`\n\n${XLSX.title}\n\n`)
    expect(sheet1).toContain(`| ${XLSX.header.join(' | ')} |`)
    // Inline string, number, 0.00-formatted number, date, percentage, boolean.
    expect(sheet1).toContain('| Kalem | 120 | 4.5 | 2026-01-15 | 25% | TRUE |')
    // Rich text, formula result, float noise, custom date-time format, error, boolean.
    expect(sheet1).toContain('| Zengin metin | 80 | 12 | 2026-01-15 12:00 | #N/A | FALSE |')
    // A total row one blank row below the table stays in it.
    expect(sheet1).toContain('| Toplam | 200 |')
    // A separate key/value block becomes its own table.
    expect(sheet1).toContain('| Anahtar | Değer |\n| --- | --- |\n| Para birimi | TRY |')
    expect(sheet1).not.toContain('gizli')
    const sheet2 = pages[1]?.markdown ?? ''
    expect(sheet2).toBe(`## ${XLSX.sheet2}\n\n- ${XLSX.notes[0]}\n- ${XLSX.notes[1]}`)
  })

  it('rejects files that are not workbooks', async () => {
    await expect(xlsxToMarkdown(await bytes('sample.docx'))).rejects.toBeInstanceOf(RagChunkerError)
    await expect(xlsxToMarkdown(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(RagChunkerError)
  })
})

describe('HTML input', () => {
  it('keeps the article and drops navigation, site header/footer, hidden and aside content', async () => {
    const html = new TextDecoder().decode(await bytes('sample.html'))
    const { markdown, title } = htmlToMarkdown(html)
    expect(title).toBe(HTML.title)
    // The article's own H1 stands; the <title> is not added on top of it.
    expect(markdown.startsWith(`# ${HTML.heading}\n\n`)).toBe(true)
    expect(markdown.match(/^# /gm)).toHaveLength(1)
    expect(markdown).toContain(`${HTML.paragraph} **Önemli:** [kaynak](https://example.org/gfr).`)
    expect(markdown).toContain(`## ${HTML.section}`)
    expect(markdown).toContain(
      `${HTML.caption}\n\n| Evre | GFR (mL/dk) |\n| --- | --- |\n| 1 | ≥ 90 |\n| 2 | 60–89 |`,
    )
    expect(markdown).toContain(`- ${HTML.bullets[0]}\n- ${HTML.bullets[1]}`)
    expect(markdown).toContain('```js\nconst gfr = 90\n```')
    expect(markdown).toContain(`![${HTML.alt}](gfr.png)`)
    expect(markdown).not.toContain('spacer.gif')
    for (const gone of [HTML.nav, HTML.hidden, HTML.aside, HTML.footer, 'tracking', 'font: 16px'])
      expect(markdown).not.toContain(gone)
  })

  it('falls back from <main> to a single <article> to <body>, and adds the title as H1 when missing', () => {
    expect(mainContent('<body><article><p>a</p></article><article><p>b</p></article></body>')).toContain(
      '<p>b</p>',
    )
    expect(mainContent('<body><p>x</p><article><p>a</p></article></body>')).toBe(
      '<article><p>a</p></article>',
    )
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Sayfa &amp; Başlık</title></head><body><p>Metin</p></body></html>',
    )
    expect(markdown).toBe('# Sayfa & Başlık\n\nMetin')
  })

  it('pads colspans and skips the rows of nested tables', () => {
    const { markdown } = htmlToMarkdown(
      '<table><thead><tr><th colspan="2">Çift</th><th>Tek</th></tr></thead><tbody><tr><td>1</td><td>2</td><td><table><tr><td>iç</td></tr></table></td></tr></tbody></table>',
    )
    expect(markdown).toContain('| Çift |  | Tek |\n| --- | --- | --- |\n| 1 | 2 | iç |')
  })
})
