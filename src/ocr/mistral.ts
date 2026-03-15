import { callWithRetry } from '../utils/llm-caller.js'
import type { OcrResult } from './types.js'

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr'
const DEFAULT_MODEL = 'mistral-ocr-latest'

interface MistralOcrPage {
  index: number
  markdown: string
}

interface MistralOcrResponse {
  pages: MistralOcrPage[]
  model: string
}

/**
 * Runs Mistral OCR 3 on a PDF buffer.
 * Returns structured OcrResult with per-page markdown.
 */
export async function runMistralOcr(
  pdfBuffer: Buffer | Uint8Array,
  opts: { apiKey: string; model?: string }
): Promise<OcrResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const b64 = Buffer.from(pdfBuffer).toString('base64')

  const data = await callWithRetry(async () => {
    const res = await fetch(MISTRAL_OCR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify({
        model,
        document: {
          type: 'document_url',
          document_url: `data:application/pdf;base64,${b64}`
        }
      })
    })

    if (!res.ok) {
      const errObj = new Error(`Mistral OCR error: ${res.status} ${res.statusText}`) as Error & { status: number }
      errObj.status = res.status
      throw errObj
    }

    return res.json() as Promise<MistralOcrResponse>
  })

  return {
    model,
    pageCount: data.pages.length,
    pages: data.pages.map(p => ({
      pageNumber: p.index + 1,  // Mistral uses 0-indexed pages
      markdown: p.markdown,
      model
    }))
  }
}
