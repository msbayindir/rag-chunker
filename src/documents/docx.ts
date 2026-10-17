import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { RagChunkerError } from '../errors.js'

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })
  td.use(gfm)
  // Embedded images carry no text for retrieval.
  td.remove('img' as keyof HTMLElementTagNameMap)
  td.addRule('emptyAnchors', {
    filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim() === '',
    replacement: () => '',
  })
  return td
}

/** mammoth emits header cells as <td><p>…</p></td>; the GFM converter needs <th> to produce a pipe table. */
function normalizeTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_m, inner: string) => {
    let first = true
    const fixed = inner
      .replace(/<\/?p>/g, ' ')
      .replace(/<tr>([\s\S]*?)<\/tr>/g, (row: string, cells: string) => {
        if (!first) return row
        first = false
        return `<tr>${cells.replace(/<td(\s|>)/g, '<th$1').replace(/<\/td>/g, '</th>')}</tr>`
      })
    return `<table>${fixed}</table>`
  })
}

/** Converts a .docx file to markdown (headings come from Word heading styles). */
export async function docxToMarkdown(bytes: Uint8Array): Promise<{ markdown: string; warnings: string[] }> {
  let html: string
  let messages: Array<{ type: string; message: string }>
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    )
    html = result.value
    messages = result.messages
  } catch (err) {
    throw new RagChunkerError('INPUT_INVALID', `Could not read DOCX: ${(err as Error).message}`, {
      cause: err,
    })
  }
  const markdown = createTurndown()
    .turndown(normalizeTables(html))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const warnings = messages.filter((m) => m.type === 'error').map((m) => `DOCX: ${m.message}`)
  return { markdown, warnings }
}
