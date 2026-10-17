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
