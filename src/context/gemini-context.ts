import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { ILogger } from '../logger.js'
import { callWithRetry, extractJson } from '../utils/llm-caller.js'

const BatchContextSchema = z.object({
  summaries: z.array(z.string().min(1).max(600))
})

const ContextSummarySchema = z.object({
  contextSummary: z.string().min(1).max(600)
})

const CONTEXT_SYSTEM_PROMPT = `Sen bir teknik editörsün.
global_referans: Tüm doküman. Bağlamı anlamak için kullan.
islem_yapilacak_hedef: Aşağıdaki metin parçası.
Görev: Bu parçanın tüm dokümandaki yerini ve önemini açıklayan
TAM OLARAK 2 cümlelik bağlam özeti yaz.
Kural: Özet bu parça olmadan da bağlamı anlaşılır kılmalıdır.
ÇIKTI: Sadece JSON. { "contextSummary": "..." }`

/**
 * Evaluates text quality for context generation.
 * Diagram/figure pages with OCR artifacts are skipped.
 */
function isLowQualityText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 80) return true

  const meaningful = (trimmed.match(/[A-Za-zÇçĞğİıÖöŞşÜü0-9]/g) ?? []).length
  const ratio = meaningful / trimmed.length
  return ratio < 0.45
}

/** Document context — either full markdown text or a pre-created Gemini cache ID. */
export type DocContext =
  | { type: 'text'; markdown: string }
  | { type: 'cache'; cacheId: string }


/**
 * Generates a 2-sentence context summary for a chunk using the full document as context.
 * Throws on low-quality text or API failure (caller handles gracefully).
 *
 * Pass `docCtx: { type: 'cache', cacheId }` to reuse a Gemini CachedContent
 * (created via createDocumentCache) and avoid resending the full markdown each time.
 */
export async function generateContext(
  chunkContent: string,
  docCtx: DocContext,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<string> {
  if (isLowQualityText(chunkContent)) {
    opts.logger.debug('Low quality text, skipping context', { length: chunkContent.length })
    throw new Error('low-quality-text: context generation skipped')
  }

  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const response = await callWithRetry(() => {
    if (docCtx.type === 'cache') {
      return ai.models.generateContent({
        model: opts.model,
        contents: [{
          role: 'user',
          parts: [{ text: chunkContent }, { text: CONTEXT_SYSTEM_PROMPT }]
        }],
        config: { cachedContent: docCtx.cacheId }
      })
    }
    return ai.models.generateContent({
      model: opts.model,
      contents: [{
        role: 'user',
        parts: [
          { text: docCtx.markdown },
          { text: chunkContent },
          { text: CONTEXT_SYSTEM_PROMPT }
        ]
      }]
    })
  })

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const json = extractJson(rawText)
  const parsed = ContextSummarySchema.parse(JSON.parse(json))
  return parsed.contextSummary
}

/**
 * Generates context summaries for N chunks in a single API call.
 * Low-quality chunks are skipped; their positions return null.
 * Return array is index-aligned with chunkContents.
 *
 * Pass `docCtx: { type: 'cache', cacheId }` to reuse a Gemini CachedContent.
 */
export async function generateContextBatch(
  chunkContents: string[],
  docCtx: DocContext,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(chunkContents.length).fill(null)

  const validItems = chunkContents
    .map((content, i) => ({ content, idx: i }))
    .filter(({ content }) => !isLowQualityText(content))

  if (validItems.length === 0) return results

  const chunkBlock = validItems
    .map(({ content }, pos) => `[PARÇA ${pos + 1}]\n${content}`)
    .join('\n\n---\n\n')

  const prompt = `global_referans: Tüm doküman. Bağlamı anlamak için kullan.
Aşağıda ${validItems.length} adet metin parçası var.
Her parça için TAM OLARAK 2 cümlelik bağlam özeti yaz.
Kural: Her özet, parça olmadan da bağlamı anlaşılır kılmalıdır.
ÇIKTI: Sadece JSON.
{ "summaries": ["<parça 1 özeti>", "<parça 2 özeti>"] }

${chunkBlock}`

  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const response = await callWithRetry(() => {
    if (docCtx.type === 'cache') {
      return ai.models.generateContent({
        model: opts.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { cachedContent: docCtx.cacheId }
      })
    }
    return ai.models.generateContent({
      model: opts.model,
      contents: [{
        role: 'user',
        parts: [{ text: docCtx.markdown }, { text: prompt }]
      }]
    })
  })

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const parsed = BatchContextSchema.parse(JSON.parse(extractJson(rawText)))

  for (let i = 0; i < validItems.length; i++) {
    const summary = parsed.summaries[i]
    if (summary) results[validItems[i]!.idx] = summary
  }

  return results
}
