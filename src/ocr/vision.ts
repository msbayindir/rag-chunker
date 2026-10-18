import type { GenerateResult, LLM } from '../providers/types.js'
import { cleanPageMarkdown } from './postprocess.js'

export const VISION_PROMPT_VERSION = 'v1'

const VISION_SYSTEM = `You are an OCR engine. Transcribe the page image into clean GitHub-flavored Markdown.
Rules:
- Reproduce all text exactly, in its original language. Never translate, summarise or add commentary.
- Use #, ## and ### for headings following the visual hierarchy of the page.
- Render tables as GFM pipe tables and lists as Markdown lists.
- Leave out running headers, footers and page numbers.
- Ignore pictures; do not describe them.
- If the page contains no text, answer with an empty response.
Output only the Markdown.`

export const FIGURE_PROMPT_VERSION = 'v3'

const FIGURE_SYSTEM = `You describe figures from documents for a search index.
Rules:
- Say what kind of figure it is (chart, diagram, photo, screenshot, map, table image…) and what it shows.
- Name the axes, legend entries, labels, and the key values or the trend when they are readable.
- Language: the user message names the language to write in; never switch to English when another language is named.
- Two to five sentences of plain text. No markdown, no preamble, nothing that is not visible.`

/** Describes a figure (PNG) with a vision-capable LLM: a short paragraph for retrieval. */
export async function describeFigure(
  llm: LLM,
  image: Uint8Array,
  context: { caption?: string; nearby?: string },
  signal?: AbortSignal,
): Promise<{ text: string; usage: GenerateResult['usage'] }> {
  const sample = context.caption ?? context.nearby
  const language = sample
    ? `Write the description in the language of this text from the page (not in English unless that text is English): "${sample}"`
    : 'Write the description in the language of the text in the image (English if there is none).'
  const text = `${context.caption ? `Caption on the page: ${context.caption}\n` : ''}${language}\n\nDescribe this figure.`
  const res = await llm.generate({
    system: FIGURE_SYSTEM,
    parts: [
      { type: 'image', data: image, mimeType: 'image/png' },
      { type: 'text', text },
    ],
    maxOutputTokens: 400,
    effort: 'low',
    signal,
  })
  return { text: res.text.replace(/\s+/g, ' ').trim(), usage: res.usage }
}

/** OCRs one page image with a vision-capable LLM. */
export async function visionOcrPage(
  llm: LLM,
  image: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ markdown: string; usage: GenerateResult['usage'] }> {
  const res = await llm.generate({
    system: VISION_SYSTEM,
    parts: [
      { type: 'image', data: image, mimeType },
      { type: 'text', text: 'Transcribe this page.' },
    ],
    maxOutputTokens: 4096,
    effort: 'low',
    signal,
  })
  return { markdown: cleanPageMarkdown(res.text, { stripImages: true }), usage: res.usage }
}
