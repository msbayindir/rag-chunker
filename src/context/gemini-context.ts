import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { ILogger } from '../logger.js'
import { callWithRetry, extractJson } from '../utils/llm-caller.js'

const ContextSummarySchema = z.object({
  contextSummary: z.string().min(1).max(600)
})

const CONTEXT_SYSTEM_PROMPT = `You are a technical editor.
The full document has been provided as context above.
Task: Write a context summary for the chunk below — what section it belongs to, what topic it covers, why it matters in context.
Rules:
- Exactly 1-2 sentences
- Do NOT repeat the chunk's content
- Write in the SAME language as the document
Output: JSON only. { "contextSummary": "..." }`

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
 * (created via createContextCache) and avoid resending the full markdown each time.
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
 * Creates a Gemini CachedContent from the full document markdown.
 * Returns the cache name (e.g. "cachedContents/abc123") or null on failure.
 * Failure is non-fatal — callers fall back to inline text mode.
 */
export async function createContextCache(
  documentMd: string,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<string | null> {
  try {
    const ai = new GoogleGenAI({ apiKey: opts.apiKey })
    const cache = await ai.caches.create({
      model: opts.model,
      config: {
        contents: [{ role: 'user', parts: [{ text: documentMd }] }],
        ttl: '3600s'
      }
    })
    const name = (cache as { name?: string }).name ?? null
    opts.logger.debug('Gemini context cache created', { name })
    return name
  } catch (err) {
    opts.logger.warn('Gemini context cache creation failed — falling back to inline text', { err })
    return null
  }
}

/**
 * Generates context summaries for N chunks in a single API call.
 * Low-quality chunks are skipped; their positions return null.
 * Return array is index-aligned with chunks input.
 *
 * Pass `docCtx: { type: 'cache', cacheId }` to reuse a Gemini CachedContent.
 */
export async function generateContextBatch(
  chunks: Array<{ rawContent: string; sectionPath: string[]; pageNumber: number; mustPreserve?: boolean }>,
  docCtx: DocContext,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(chunks.length).fill(null)

  const validItems = chunks
    .map((chunk, i) => ({ chunk, idx: i }))
    .filter(({ chunk }) => chunk.mustPreserve || !isLowQualityText(chunk.rawContent))

  if (validItems.length === 0) return results

  const n = validItems.length

  const chunkBlock = validItems.map(({ chunk }, pos) => {
    const section = chunk.sectionPath.length > 0 ? chunk.sectionPath.join(' > ') : '(root)'
    return `CHUNK ${pos + 1} | Section: ${section} | Page: ${chunk.pageNumber}\n\`\`\`\n${chunk.rawContent}\n\`\`\``
  }).join('\n\n')

  const prompt = `Below are ${n} chunks from this document.
For each chunk, write 1-2 sentences that situate it within the document — what section it belongs to, what topic it covers, why it matters in context.
Rules:
- Do NOT repeat the chunk's content
- Write in the SAME language as the document

Respond with ONLY a JSON array of exactly ${n} strings, one per chunk, in order:
["<context for chunk 1>", "<context for chunk 2>"]

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

  let trimmed = extractJson(rawText).trim()

  // Truncation recovery — response cut off before closing bracket
  if (!trimmed.endsWith(']')) {
    const lastQuote = trimmed.lastIndexOf('"')
    if (lastQuote > 0) trimmed = trimmed.slice(0, lastQuote + 1) + ']'
    else return results
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    opts.logger.warn('generateContextBatch: failed to parse JSON response')
    return results
  }

  if (!Array.isArray(parsed)) return results

  // Normalise length to match validItems count
  const arr: unknown[] = parsed.length < n
    ? [...parsed, ...new Array(n - parsed.length).fill('')]
    : parsed.slice(0, n)

  for (let i = 0; i < validItems.length; i++) {
    const summary = arr[i]
    if (typeof summary === 'string' && summary.length > 0) {
      results[validItems[i]!.idx] = summary
    }
  }

  return results
}
