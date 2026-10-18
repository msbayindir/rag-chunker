import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import { requestJson } from './http.js'
import { toProviderError } from './retry.js'
import { toBase64 } from './types.js'

export const MISTRAL_OCR_MODEL = 'mistral-ocr-latest'
/** Mistral rejects requests above ~50 MB; stay well below it. */
export const MISTRAL_MAX_BYTES = 40 * 1024 * 1024
export const MISTRAL_MAX_PAGES = 500

export interface MistralOcrPage {
  /** 0-based page index within the submitted document. */
  index: number
  markdown: string
}

interface MistralOcrResponse {
  model?: string
  pages: Array<{ index: number; markdown: string; header?: string | null; footer?: string | null }>
  usage_info?: { pages_processed?: number }
}

export interface MistralOcrInput {
  provider: ResolvedProvider
  bytes: Uint8Array
  mime: string
  kind: 'pdf' | 'docx' | 'pptx' | 'image'
  /** 0-based pages to process (PDF only). */
  pages?: number[]
  signal?: AbortSignal
}

/** Runs Mistral OCR on a document or image. Headers/footers are extracted out of the page text. */
export async function mistralOcr(
  input: MistralOcrInput,
): Promise<{ pages: MistralOcrPage[]; model: string; pagesProcessed: number }> {
  const { provider } = input
  if (!provider.apiKey) {
    throw new RagChunkerError('MISSING_API_KEY', 'Mistral OCR needs an API key', {
      hint: `Set ${provider.apiKeyEnv.join(' or ') || 'MISTRAL_API_KEY'}`,
    })
  }
  const dataUrl = `data:${input.mime};base64,${toBase64(input.bytes)}`
  const document =
    input.kind === 'image'
      ? { type: 'image_url', image_url: dataUrl }
      : { type: 'document_url', document_url: dataUrl }
  const body: Record<string, unknown> = {
    model: MISTRAL_OCR_MODEL,
    document,
    include_image_base64: false,
    extract_header: true,
    extract_footer: true,
  }
  if (input.pages && input.pages.length > 0) body.pages = input.pages
  const base = provider.baseURL ?? 'https://api.mistral.ai/v1'
  try {
    const res = await requestJson<MistralOcrResponse>(`${base.replace(/\/$/, '')}/ocr`, {
      body,
      headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
      timeoutMs: Math.max(provider.timeoutMs, 600_000),
      maxRetries: provider.maxRetries,
      signal: input.signal,
    })
    if (!res || !Array.isArray(res.pages)) {
      throw new RagChunkerError('PROVIDER_ERROR', 'Mistral OCR returned no pages')
    }
    return {
      pages: res.pages.map((p) => ({ index: p.index, markdown: p.markdown ?? '' })),
      model: res.model ?? MISTRAL_OCR_MODEL,
      pagesProcessed: res.usage_info?.pages_processed ?? res.pages.length,
    }
  } catch (err) {
    throw toProviderError(err, `${provider.name}/${MISTRAL_OCR_MODEL}`, provider.apiKeyEnv)
  }
}
