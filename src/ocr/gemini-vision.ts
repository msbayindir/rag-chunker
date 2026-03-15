import { GoogleGenAI } from '@google/genai'
import { callWithRetry } from '../utils/llm-caller.js'
import type { OcrResult } from './types.js'

const OCR_PROMPT =
  'Convert this PDF document to clean GFM markdown. ' +
  'Preserve tables as pipe-delimited GFM. ' +
  'Use appropriate heading levels (# for main titles, ## for sections, etc.). ' +
  'Output only the markdown content without any preamble or explanation.'

const DEFAULT_MODEL = 'gemini-2.0-flash'

/**
 * Gemini Vision fallback OCR — used when no Mistral API key is configured.
 * Uploads the PDF to Gemini Files API and requests a single markdown conversion.
 */
export async function runGeminiVisionOcr(
  pdfBuffer: Buffer | Uint8Array,
  opts: { apiKey: string; model?: string }
): Promise<OcrResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  // Upload PDF to Gemini Files API
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' })
  const uploaded = await callWithRetry(() =>
    ai.files.upload({ file: blob, config: { mimeType: 'application/pdf', displayName: 'document.pdf' } })
  )

  const fileUri = uploaded.uri!
  const mimeType = 'application/pdf'

  // Request markdown conversion
  const response = await callWithRetry(() =>
    ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { fileData: { mimeType, fileUri } },
          { text: OCR_PROMPT }
        ]
      }]
    })
  )

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

  return {
    model,
    pageCount: 1,
    pages: [{
      pageNumber: 1,
      markdown: rawText,
      model
    }]
  }
}
