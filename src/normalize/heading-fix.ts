import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { callWithRetry, extractJson } from '../utils/llm-caller.js'
import type { ILogger } from '../logger.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HeadingCorrection {
  originalText: string
  originalLevel: number
  correctedLevel: number
  parentHeading: string | null
}

const CorrectionsSchema = z.array(z.object({
  originalText: z.string(),
  originalLevel: z.number().int().min(1).max(6),
  correctedLevel: z.number().int().min(1).max(6),
  parentHeading: z.string().nullable()
}))

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PROMPT = `You are a document structure expert analyzing OCR-produced markdown.

The OCR software processes pages independently, so heading levels (# ## ###) may be \
inconsistent — sub-headings are sometimes incorrectly marked as top-level (# instead of ##).

Analyze the heading hierarchy in the document and identify headings with incorrect levels.

Guidelines:
- H1 (#): Major chapters or parts only (e.g. "KARBONHİDRATLAR", "LİPİT METABOLİZMASI")
- H2 (##): Numbered topic headings and sections within a chapter
- H3 (###): Sub-topics and subsections
- Sidebar labels ("Spot Bilgiler", "Klinik Korelasyon", "Sorular") → H2
- Table/figure captions → H3

Return ONLY headings that need level correction as a JSON array.
If no corrections are needed, return an empty array: []

Format (raw JSON, no markdown fences):
[{"originalText": "...", "originalLevel": 1, "correctedLevel": 2, "parentHeading": "parent text or null"}]`

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripInlineFormatting(text: string): string {
  return text.replace(/\*+/g, '').replace(/_+/g, '').trim()
}

function applyCorrections(
  markdown: string,
  corrections: HeadingCorrection[],
  logger: ILogger
): { result: string; applied: number; missed: string[] } {
  const lines = markdown.split('\n')
  let applied = 0
  const missed: string[] = []

  for (const c of corrections) {
    if (c.originalLevel === c.correctedLevel) continue
    const oldHashes = '#'.repeat(c.originalLevel)
    const newHashes = '#'.repeat(c.correctedLevel)
    const targetText = c.originalText.trim()

    let found = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.startsWith(oldHashes + ' ')) continue
      const lineText = stripInlineFormatting(line.slice(oldHashes.length + 1))
      if (lineText === targetText) {
        // Keep original inline formatting, just change the # level
        lines[i] = newHashes + ' ' + line.slice(oldHashes.length + 1)
        found = true
        applied++
        break
      }
    }

    if (!found) {
      missed.push(`${oldHashes} ${c.originalText}`)
    }
  }

  return { result: lines.join('\n'), applied, missed }
}

// ─── Gemini document cache ────────────────────────────────────────────────────

/**
 * Creates a Gemini CachedContent from the full document markdown.
 * Returns the cache name (e.g. "cachedContents/abc123") or null on failure.
 * Used to share the document context between heading fix and context enrichment calls.
 */
export async function createDocumentCache(
  documentMd: string,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<string | null> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  try {
    const cache = await callWithRetry(() =>
      ai.caches.create({
        model: opts.model,
        config: {
          contents: [{ role: 'user', parts: [{ text: documentMd }] }],
          ttl: '3600s'
        }
      })
    )
    opts.logger.info('Gemini document cache created', { name: cache.name })
    return cache.name ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    opts.logger.warn(`Gemini cache creation failed: ${msg}`)
    return null
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Calls Gemini to detect and fix inconsistent heading levels in OCR-produced markdown.
 * Always fails gracefully — returns original markdown if the API call fails.
 *
 * @param documentMd - Full document markdown from OCR
 * @param config.cacheId - Gemini cache name to use (avoids resending the full document)
 */
export async function fixHeadingHierarchy(
  documentMd: string,
  config: {
    geminiApiKey: string
    geminiModel?: string
    cacheId?: string | null
    logger: ILogger
  }
): Promise<{ correctedMd: string; corrections: HeadingCorrection[] }> {
  const model = config.geminiModel ?? 'gemini-2.0-flash'
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey })

  try {
    const response = await callWithRetry(() => {
      if (config.cacheId) {
        return ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
          config: { cachedContent: config.cacheId }
        })
      }
      return ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [{ text: documentMd }, { text: PROMPT }]
        }]
      })
    })

    const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const trimmed = extractJson(rawText).trim()

    if (!trimmed || trimmed === '[]') {
      config.logger.info('Heading normalization: no corrections needed')
      return { correctedMd: documentMd, corrections: [] }
    }

    const corrections = CorrectionsSchema.parse(JSON.parse(trimmed))
    if (corrections.length === 0) {
      return { correctedMd: documentMd, corrections: [] }
    }

    const { result: correctedMd, applied, missed } = applyCorrections(documentMd, corrections, config.logger)
    config.logger.info(`Heading normalization: ${applied}/${corrections.length} corrections applied`)
    if (missed.length > 0) {
      config.logger.warn(`Heading normalization: ${missed.length} headings not found in document — sample: ${missed.slice(0, 3).join(' | ')}`)
    }
    return { correctedMd, corrections }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    config.logger.warn(`Heading normalization failed: ${msg}`)
    return { correctedMd: documentMd, corrections: [] }
  }
}
