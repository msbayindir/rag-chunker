import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fontkit from '@pdf-lib/fontkit'
import JSZip from 'jszip'
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib'
import { renderPageAsImage } from 'unpdf'
import {
  DOCX,
  HEADER,
  PAGE1,
  PAGE2,
  PAGE3,
  PPTX,
  SCANNED,
  SIDE_BY_SIDE,
  TABLES,
  TWO_COLUMN,
} from './content.js'

const VERSION = '7'
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated')
export const fixture = (name: string) => join(FIXTURES_DIR, name)

const require = createRequire(import.meta.url)
const fontDir = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf')

interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit)
  const regular = await doc.embedFont(await readFile(join(fontDir, 'DejaVuSans.ttf')), { subset: true })
  const bold = await doc.embedFont(await readFile(join(fontDir, 'DejaVuSans-Bold.ttf')), { subset: true })
  return { regular, bold }
}

/** Draws wrapped text and returns the next y position. */
function drawWrapped(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  width: number,
): number {
  const words = text.split(' ')
  let line = ''
  const lineHeight = size * 1.35
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) > width && line) {
      page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) })
      y -= lineHeight
      line = word
    } else {
      line = candidate
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) })
    y -= lineHeight
  }
  return y
}

function frame(page: PDFPage, fonts: Fonts, pageNumber: number): void {
  page.drawText(HEADER, { x: 56, y: 806, size: 9, font: fonts.regular })
  page.drawText(`Sayfa ${pageNumber}`, { x: 280, y: 30, size: 9, font: fonts.regular })
}

async function renderScannedPng(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)
  const page = doc.addPage([595, 842])
  let y = 760
  page.drawText(SCANNED.heading, { x: 56, y, size: 16, font: fonts.bold })
  y -= 34
  drawWrapped(page, SCANNED.paragraph, fonts.regular, 13, 56, y, 480)
  const bytes = await doc.save()
  const png = await renderPageAsImage(new Uint8Array(bytes), 1, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 2,
  })
  return new Uint8Array(png)
}

async function buildTurkishPdf(scanPng: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)

  const p1 = doc.addPage([595, 842])
  frame(p1, fonts, 1)
  let y = 740
  p1.drawText(PAGE1.title, { x: 56, y, size: 22, font: fonts.bold })
  y -= 44
  p1.drawText(PAGE1.heading, { x: 56, y, size: 16, font: fonts.bold })
  y -= 30
  for (const para of PAGE1.paragraphs) y = drawWrapped(p1, para, fonts.regular, 11, 56, y, 480) - 12

  const p2 = doc.addPage([595, 842])
  frame(p2, fonts, 2)
  y = 760
  p2.drawText(PAGE2.heading, { x: 56, y, size: 13, font: fonts.bold })
  y -= 26
  y = drawWrapped(p2, PAGE2.paragraph, fonts.regular, 11, 56, y, 480) - 12
  for (const b of PAGE2.bullets) {
    p2.drawText(`• ${b}`, { x: 66, y, size: 11, font: fonts.regular })
    y -= 15
  }
  y -= 12
  for (const line of PAGE2.hyphenated) {
    p2.drawText(line, { x: 56, y, size: 11, font: fonts.regular })
    y -= 15
  }

  const p3 = doc.addPage([595, 842])
  frame(p3, fonts, 3)
  y = 760
  p3.drawText(PAGE3.heading, { x: 56, y, size: 16, font: fonts.bold })
  y -= 30
  for (const para of PAGE3.paragraphs) y = drawWrapped(p3, para, fonts.regular, 11, 56, y, 480) - 12

  const p4 = doc.addPage([595, 842])
  const img = await doc.embedPng(scanPng)
  p4.drawImage(img, { x: 0, y: 0, width: 595, height: 842 })

  doc.setTitle('Elektrolit Bozuklukları')
  return doc.save()
}

async function buildTwoColumnPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)
  const page = doc.addPage([595, 842])
  let yl = 780
  let yr = 780
  for (let i = 0; i < 3; i++) {
    for (const p of TWO_COLUMN.left) yl = drawWrapped(page, p, fonts.regular, 10, 40, yl, 240) - 10
    for (const p of TWO_COLUMN.right) yr = drawWrapped(page, p, fonts.regular, 10, 315, yr, 240) - 10
  }
  return doc.save()
}

async function buildSideBySidePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)
  const page = doc.addPage([595, 842])
  let y = drawWrapped(page, SIDE_BY_SIDE.intro, fonts.regular, 10, 40, 780, 515) - 10
  const yl = drawWrapped(page, SIDE_BY_SIDE.left, fonts.regular, 10, 40, y, 240)
  const yr = drawWrapped(page, SIDE_BY_SIDE.right, fonts.regular, 10, 315, y, 240)
  y = Math.min(yl, yr) - 10
  drawWrapped(page, SIDE_BY_SIDE.outro, fonts.regular, 10, 40, y, 515)
  return doc.save()
}

function hline(page: PDFPage, x0: number, x1: number, y: number): void {
  page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: 0.8, color: rgb(0, 0, 0) })
}
function vline(page: PDFPage, x: number, y0: number, y1: number): void {
  page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness: 0.8, color: rgb(0, 0, 0) })
}

/** A grid table: `cols` are the vertical boundaries, rows are `rowHeight` tall from `top` down. */
function drawGrid(
  page: PDFPage,
  font: PDFFont,
  cols: number[],
  top: number,
  rowHeight: number,
  rows: string[][],
  options: { bottomAsRect?: boolean } = {},
): number {
  const left = cols[0] as number
  const right = cols.at(-1) as number
  const bottom = top - rowHeight * rows.length
  for (let r = 0; r <= rows.length; r++) {
    const y = top - rowHeight * r
    if (r === rows.length && options.bottomAsRect) {
      page.drawRectangle({ x: left, y: y - 0.3, width: right - left, height: 0.6, color: rgb(0, 0, 0) })
    } else hline(page, left, right, y)
  }
  for (const x of cols) vline(page, x, bottom, top)
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (text)
        page.drawText(text, { x: (cols[c] as number) + 4, y: top - rowHeight * r - 13, size: 10, font })
    })
  })
  return bottom
}

async function buildTablesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFonts(doc)
  const f = fonts.regular

  // Page 1: a ruled grid with a two-row header (row spans and a column span), then a rules-only table.
  const p1 = doc.addPage([595, 842])
  p1.drawText(TABLES.caption1, { x: 56, y: 720, size: 10, font: fonts.bold })
  const cols = [56, 200, 290, 380, 470]
  const top = 700
  const rh = 18
  const nRows = 2 + TABLES.ruled.rows.length
  const bottom = top - rh * nRows
  for (let r = 0; r <= nRows; r++) {
    const y = top - rh * r
    if (r === 1)
      hline(p1, 290, 470, y) // header rows 0 and 1 merge in the first two columns
    else hline(p1, 56, 470, y)
  }
  for (const x of cols) {
    if (x === 380)
      vline(p1, x, bottom, top - rh) // no divider inside the spanning header cell
    else vline(p1, x, bottom, top)
  }
  p1.drawText('Parametre', { x: 60, y: top - 2 * rh + 12, size: 10, font: f })
  p1.drawText('Birim', { x: 204, y: top - 2 * rh + 12, size: 10, font: f })
  p1.drawText('Referans aralığı', { x: 294, y: top - 13, size: 10, font: f })
  p1.drawText('Alt sınır', { x: 294, y: top - rh - 13, size: 10, font: f })
  p1.drawText('Üst sınır', { x: 384, y: top - rh - 13, size: 10, font: f })
  TABLES.ruled.rows.forEach((row, i) => {
    const y = top - rh * (2 + i) - 13
    row.forEach((text, c) => {
      if (c === 0 && text.includes(' ')) {
        // A cell whose text wraps onto two lines.
        const [a, b] = text.split(' ')
        p1.drawText(a as string, { x: 60, y: y + 4, size: 8, font: f })
        p1.drawText(b as string, { x: 60, y: y - 5, size: 8, font: f })
      } else p1.drawText(text, { x: (cols[c] as number) + 4, y, size: 10, font: f })
    })
  })
  let y = drawWrapped(p1, TABLES.afterRuled, f, 10, 56, 560, 480) - 20
  p1.drawText(TABLES.caption3, { x: 56, y, size: 10, font: fonts.bold })
  y -= 15
  hline(p1, 56, 200, y)
  const rulesX = [60, 100, 132]
  const rulesRows = [TABLES.rules.header, ...TABLES.rules.rows]
  rulesRows.forEach((row, i) => {
    const base = y - 13 - 14 * i
    row.forEach((text, c) => p1.drawText(text, { x: rulesX[c] as number, y: base, size: 10, font: f }))
    if (i === 0) hline(p1, 56, 200, base - 4)
  })
  hline(p1, 56, 200, y - 13 - 14 * (rulesRows.length - 1) - 4)

  // Page 2: an aligned table without any lines, a paragraph, then a grid that runs off the page.
  const p2 = doc.addPage([595, 842])
  p2.drawText(TABLES.caption2, { x: 56, y: 760, size: 10, font: fonts.bold })
  const alignedRows = [TABLES.aligned.header, ...TABLES.aligned.rows]
  alignedRows.forEach((row, i) => {
    const base = 735 - 16 * i
    p2.drawText(row[0] as string, { x: 56, y: base, size: 10, font: f })
    p2.drawText(row[1] as string, { x: 200, y: base, size: 10, font: f })
    const last = row[2] as string
    p2.drawText(last, { x: 430 - f.widthOfTextAtSize(last, 10), y: base, size: 10, font: f })
  })
  drawWrapped(p2, TABLES.afterAligned, f, 10, 56, 610, 480)
  drawGrid(p2, f, [56, 220, 380, 480], 200, 18, [TABLES.continued.header, ...TABLES.continued.firstPage])

  // Page 3: the continuation rows at the very top, without a header, then a paragraph.
  const p3 = doc.addPage([595, 842])
  const end = drawGrid(p3, f, [56, 220, 380, 480], 810, 18, TABLES.continued.secondPage, {
    bottomAsRect: true,
  })
  drawWrapped(p3, TABLES.afterContinued, f, 10, 56, end - 30, 480)
  return doc.save()
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function wPara(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

async function buildDocx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  )
  const rows = DOCX.table
    .map((r) => `<w:tr>${r.map((c) => `<w:tc>${wPara(c)}</w:tc>`).join('')}</w:tr>`)
    .join('')
  const body = [
    wPara(DOCX.h1, 'Heading1'),
    wPara(DOCX.p1),
    wPara(DOCX.h2, 'Heading2'),
    wPara(DOCX.p2),
    `<w:tbl><w:tblPr/>${rows}</w:tbl>`,
  ].join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function aPara(text: string, lvl = 0): string {
  return `<a:p><a:pPr lvl="${lvl}"/><a:r><a:t>${text}</a:t></a:r></a:p>`
}

function titleShape(text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${aPara(text)}</p:txBody></p:sp>`
}

async function buildPptx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`,
  )
  const bullets = PPTX.slide1.bullets.map((b, i) => aPara(b, i === 0 ? 0 : 1)).join('')
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"><p:cSld><p:spTree>${titleShape(PPTX.slide1.title)}<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${bullets}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  )
  zip.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${aPara(PPTX.slide1.notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  )
  const rows = PPTX.slide2.table
    .map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody>${aPara(c)}</a:txBody></a:tc>`).join('')}</a:tr>`)
    .join('')
  zip.file(
    'ppt/slides/slide2.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"><p:cSld><p:spTree>${titleShape(PPTX.slide2.title)}<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const MARKDOWN = `# Asit-Baz Dengesi

Kan pH değeri normalde 7,35 ile 7,45 arasında tutulur.

## Metabolik Asidoz

Metabolik asidozda bikarbonat düzeyi düşer ve anyon açığı hesaplanmalıdır.

| Parametre | Değer |
|---|---|
| pH | 7,35-7,45 |
| HCO3 | 22-26 mmol/L |
`

/** Generates every fixture once (re-generated when VERSION changes). */
export async function generateFixtures(): Promise<void> {
  const marker = fixture('.version')
  if (existsSync(marker) && (await readFile(marker, 'utf8')) === VERSION) return
  await mkdir(FIXTURES_DIR, { recursive: true })
  const scan = await renderScannedPng()
  await writeFile(fixture('scan.png'), scan)
  await writeFile(fixture('turkish.pdf'), await buildTurkishPdf(scan))
  await writeFile(fixture('two-column.pdf'), await buildTwoColumnPdf())
  await writeFile(fixture('side-by-side.pdf'), await buildSideBySidePdf())
  await writeFile(fixture('tables.pdf'), await buildTablesPdf())
  await writeFile(fixture('sample.docx'), await buildDocx())
  await writeFile(fixture('sample.pptx'), await buildPptx())
  await writeFile(fixture('sample.md'), MARKDOWN)
  await writeFile(marker, VERSION)
}
