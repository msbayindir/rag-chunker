import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import { RagChunkerError } from '../errors.js'

type XNode = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
})

const tagOf = (node: XNode): string | undefined => Object.keys(node).find((k) => k !== ':@')
const childrenOf = (node: XNode): XNode[] => {
  const tag = tagOf(node)
  const value = tag ? node[tag] : undefined
  return Array.isArray(value) ? (value as XNode[]) : []
}
const attrsOf = (node: XNode): Record<string, string> => (node[':@'] as Record<string, string>) ?? {}

function* walk(nodes: XNode[]): Generator<XNode> {
  for (const n of nodes) {
    yield n
    yield* walk(childrenOf(n))
  }
}

function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const n of walk(nodes)) if (tagOf(n) === tag) return n
  return undefined
}

/** Text of a DrawingML paragraph (<a:p>): runs, fields and line breaks. */
function paragraphText(p: XNode): string {
  let text = ''
  for (const n of walk(childrenOf(p))) {
    const tag = tagOf(n)
    if (tag === 'a:t') {
      for (const c of childrenOf(n)) if (typeof c['#text'] === 'string') text += c['#text']
    } else if (tag === 'a:br') {
      text += ' '
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

function paragraphLevel(p: XNode): number {
  const pPr = childrenOf(p).find((c) => tagOf(c) === 'a:pPr')
  const lvl = pPr ? Number(attrsOf(pPr)['@lvl'] ?? 0) : 0
  return Number.isFinite(lvl) ? lvl : 0
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function tableToMarkdown(tbl: XNode): string {
  const rows: string[][] = []
  for (const tr of childrenOf(tbl).filter((c) => tagOf(c) === 'a:tr')) {
    const cells = childrenOf(tr)
      .filter((c) => tagOf(c) === 'a:tc')
      .map((tc) => {
        const paras = [...walk(childrenOf(tc))].filter((n) => tagOf(n) === 'a:p').map(paragraphText)
        return escapeCell(paras.filter((t) => t !== '').join(' '))
      })
    if (cells.length > 0) rows.push(cells)
  }
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
  return [line(rows[0] as string[]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
}

/** Markdown for one slide: title as heading, bullet levels as nested lists, tables as GFM tables. */
function slideToMarkdown(xml: string, slideNumber: number): string {
  const doc = parser.parse(xml) as XNode[]
  const spTree = find(doc, 'p:spTree')
  if (!spTree) return ''
  const blocks: string[] = []
  let title = ''

  for (const shape of childrenOf(spTree)) {
    const tag = tagOf(shape)
    if (tag === 'p:sp') {
      const ph = find(childrenOf(shape), 'p:ph')
      const phType = ph ? attrsOf(ph)['@type'] : undefined
      const txBody = find(childrenOf(shape), 'p:txBody')
      if (!txBody) continue
      const paras = childrenOf(txBody).filter((c) => tagOf(c) === 'a:p')
      if (phType === 'title' || phType === 'ctrTitle') {
        title = paras
          .map(paragraphText)
          .filter((t) => t !== '')
          .join(' ')
        continue
      }
      const lines: string[] = []
      const asList = paras.filter((p) => paragraphText(p) !== '').length > 1 || phType === 'body'
      for (const p of paras) {
        const text = paragraphText(p)
        if (text === '') continue
        lines.push(asList ? `${'  '.repeat(paragraphLevel(p))}- ${text}` : text)
      }
      if (lines.length > 0) blocks.push(lines.join('\n'))
    } else if (tag === 'p:graphicFrame') {
      const tbl = find(childrenOf(shape), 'a:tbl')
      if (tbl) {
        const md = tableToMarkdown(tbl)
        if (md) blocks.push(md)
      }
    } else if (tag === 'p:grpSp') {
      const texts = [...walk(childrenOf(shape))].filter((n) => tagOf(n) === 'a:p').map(paragraphText)
      const joined = texts.filter((t) => t !== '').join('\n\n')
      if (joined) blocks.push(joined)
    }
  }
  const heading = `## ${title || `Slide ${slideNumber}`}`
  return [heading, ...blocks].join('\n\n')
}

function notesText(xml: string): string {
  const doc = parser.parse(xml) as XNode[]
  const out: string[] = []
  for (const shape of walk(doc)) {
    if (tagOf(shape) !== 'p:sp') continue
    const ph = find(childrenOf(shape), 'p:ph')
    if (ph && attrsOf(ph)['@type'] !== 'body') continue
    const txBody = find(childrenOf(shape), 'p:txBody')
    if (!txBody) continue
    const text = childrenOf(txBody)
      .filter((c) => tagOf(c) === 'a:p')
      .map(paragraphText)
      .filter((t) => t !== '')
      .join(' ')
    if (text) out.push(text)
  }
  return out.join('\n\n')
}

function relTargets(xml: string): Map<string, string> {
  const doc = parser.parse(xml) as XNode[]
  const out = new Map<string, string>()
  for (const n of walk(doc)) {
    if (tagOf(n) !== 'Relationship') continue
    const a = attrsOf(n)
    if (a['@Id'] && a['@Target']) out.set(a['@Id'], a['@Target'])
  }
  return out
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** Converts a .pptx file to markdown with one `<!-- page N -->` section per slide (speaker notes included). */
export async function pptxToMarkdown(bytes: Uint8Array): Promise<{ markdown: string; slideCount: number }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new RagChunkerError('INPUT_INVALID', `Could not read PPTX: ${(err as Error).message}`, {
      cause: err,
    })
  }
  const presentation = await zip.file('ppt/presentation.xml')?.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string')
  if (!presentation || !rels)
    throw new RagChunkerError('INPUT_INVALID', 'Not a PowerPoint file (missing presentation.xml)')

  const targets = relTargets(rels)
  const doc = parser.parse(presentation) as XNode[]
  const slidePaths: string[] = []
  const sldIdLst = find(doc, 'p:sldIdLst')
  for (const sld of sldIdLst ? childrenOf(sldIdLst) : []) {
    const rid = attrsOf(sld)['@r:id']
    const target = rid ? targets.get(rid) : undefined
    if (target) slidePaths.push(resolvePath('ppt/presentation.xml', target))
  }

  const sections: string[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i] as string
    const xml = await zip.file(path)?.async('string')
    if (!xml) continue
    let md = slideToMarkdown(xml, i + 1)
    const slideRels = await zip
      .file(path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))
      ?.async('string')
    if (slideRels) {
      for (const [, target] of relTargets(slideRels)) {
        if (!target.includes('notesSlide')) continue
        const notesXml = await zip.file(resolvePath(path, target))?.async('string')
        const notes = notesXml ? notesText(notesXml) : ''
        if (notes) md += `\n\nNotes: ${notes}`
      }
    }
    sections.push(`<!-- page ${i + 1} -->\n\n${md}`)
  }
  return { markdown: sections.join('\n\n'), slideCount: slidePaths.length }
}
