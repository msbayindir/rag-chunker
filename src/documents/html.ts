import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/**
 * HTML pages to markdown: the main content (`<main>`, a single `<article>`, else `<body>`) without
 * scripts, styles, navigation, site header/footer and hidden elements; headings, lists, links,
 * code blocks and tables survive, images only through their alt text.
 */

export interface HtmlResult {
  markdown: string
  /** `<title>` of the page, when present. */
  title: string | null
  warnings: string[]
}

type DomNode = {
  nodeName: string
  nodeType: number
  parentNode: DomNode | null
  textContent: string | null
  innerHTML?: string
  getAttribute?: (name: string) => string | null
  hasAttribute?: (name: string) => boolean
  querySelectorAll?: (selector: string) => ArrayLike<DomNode>
  childNodes?: ArrayLike<DomNode>
}

const DROP_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'canvas',
  'svg',
  'object',
  'embed',
  'video',
  'audio',
  'nav',
  'footer',
  'aside',
  'button',
  'input',
  'select',
  'textarea',
  'dialog',
  'form',
] as const

function isHidden(node: DomNode): boolean {
  const attr = (n: string) => node.getAttribute?.(n) ?? null
  if (node.hasAttribute?.('hidden')) return true
  if (attr('aria-hidden') === 'true') return true
  const role = attr('role')
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary')
    return true
  const style = attr('style') ?? ''
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}

/** A site header is the <header> directly under <body>; one inside an article is content. */
function isSiteHeader(node: DomNode): boolean {
  return node.nodeName === 'HEADER' && node.parentNode?.nodeName === 'BODY'
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, e: string) =>
      e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : ' ',
    )

const cellConverter = (() => {
  const td = new TurndownService({ emDelimiter: '*', codeBlockStyle: 'fenced' })
  td.remove(DROP_TAGS as unknown as (keyof HTMLElementTagNameMap)[])
  td.addRule('inlineBreaks', { filter: 'br', replacement: () => ' ' })
  td.addRule('inlineImages', {
    filter: 'img',
    replacement: (_c, node) => (node as unknown as DomNode).getAttribute?.('alt')?.trim() ?? '',
  })
  return td
})()

const mdCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** GFM table from any <table>: the first row is the header (th or not), colspans pad with blanks. */
function tableToMarkdown(table: DomNode): string {
  const rows: string[][] = []
  const trs = table.querySelectorAll?.('tr') ?? []
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i] as DomNode
    // Rows of nested tables belong to those tables.
    let owner: DomNode | null = tr.parentNode
    while (owner && owner.nodeName !== 'TABLE') owner = owner.parentNode
    if (owner !== table) continue
    const cells: string[] = []
    const nodes = tr.childNodes ?? []
    for (let k = 0; k < nodes.length; k++) {
      const cell = nodes[k] as DomNode
      if (cell.nodeName !== 'TD' && cell.nodeName !== 'TH') continue
      const span = Math.max(1, Number(cell.getAttribute?.('colspan') ?? 1) || 1)
      cells.push(mdCell(cellConverter.turndown(cell.innerHTML ?? '')))
      for (let s = 1; s < span; s++) cells.push('')
    }
    if (cells.some((c) => c !== '')) rows.push(cells)
  }
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`
  const caption = table.querySelectorAll?.('caption')?.[0]
  const captionText = caption ? mdCell(cellConverter.turndown(caption.innerHTML ?? '')) : ''
  const md = [line(rows[0] as string[]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
  return `\n\n${captionText ? `${captionText}\n\n` : ''}${md}\n\n`
}

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })
  td.use(gfm)
  td.remove(DROP_TAGS as unknown as (keyof HTMLElementTagNameMap)[])
  td.remove(((node: unknown) => isHidden(node as DomNode) || isSiteHeader(node as DomNode)) as never)
  // Our own table rule runs before the GFM plugin's, which needs <th> cells to do anything.
  td.addRule('anyTable', {
    filter: 'table',
    replacement: (_content, node) => tableToMarkdown(node as unknown as DomNode),
  })
  td.addRule('altTextImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const n = node as unknown as DomNode
      const alt = n.getAttribute?.('alt')?.trim() ?? ''
      const src = n.getAttribute?.('src')?.trim() ?? ''
      return alt ? `![${alt}](${src})` : ''
    },
  })
  td.addRule('emptyAnchors', {
    filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim() === '',
    replacement: () => '',
  })
  return td
}

/** The part of the page worth reading: <main>, a single <article>, else the whole body. */
export function mainContent(html: string): string {
  const pick = (tag: string): string | null => {
    const open = new RegExp(`<${tag}[\\s>]`, 'i').exec(html)
    if (!open) return null
    const closes = [...html.matchAll(new RegExp(`</${tag}\\s*>`, 'gi'))]
    const last = closes.at(-1)
    if (!last || (last.index as number) < open.index) return null
    return html.slice(open.index, (last.index as number) + last[0].length)
  }
  const main = pick('main')
  if (main) return main
  const articles = html.match(/<article[\s>]/gi)
  if (articles?.length === 1) return pick('article') ?? html
  return pick('body') ?? html
}

/** turndown pads list markers to four characters (`-   item`); one space is the usual markdown. */
export function tidyListMarkers(markdown: string): string {
  return markdown.replace(/^([ \t]*)([-*+]|\d+[.)])[ \t]{2,}(?=\S)/gm, '$1$2 ')
}

/** Converts an HTML document to markdown; the page title becomes the H1 when the content has none. */
export function htmlToMarkdown(html: string): HtmlResult {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch
    ? decodeEntities(titleMatch[1] as string)
        .replace(/\s+/g, ' ')
        .trim() || null
    : null
  const content = mainContent(html.replace(/<!--[\s\S]*?-->/g, ''))
  let markdown = tidyListMarkers(createTurndown().turndown(content))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (title && !/^# /m.test(markdown)) markdown = `# ${title}\n\n${markdown}`.trim()
  return { markdown, title, warnings: [] }
}
