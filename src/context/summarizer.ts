import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { RawChunk, FileRef, CacheRef } from '../types.js'
import type { ILogger } from '../logger.js'
import { callWithRetry, extractJson } from '../gemini/llm-caller.js'

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
 * Metni OCR kalitesi açısından değerlendirir.
 * Diyagram/şekil sayfaları garbled karakter içerir ve özetlenemez.
 */
function isLowQualityText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 80) return true  // çok kısa

  // Anlamlı karakter oranı: harf/rakam/Türkçe karakter
  const meaningful = (trimmed.match(/[A-Za-zÇçĞğİıÖöŞşÜü0-9]/g) ?? []).length
  const ratio = meaningful / trimmed.length
  return ratio < 0.45  // %45 altı → büyük ihtimalle diyagram/şekil OCR'ı
}

/**
 * Chunk metninin tüm dokümandaki bağlamını açıklayan 2 cümlelik özet üretir.
 * Başarısız olursa throw eder (caller '' döner ve failedSteps ekler).
 * Düşük kaliteli OCR metni için API çağrısı yapılmadan throw edilir.
 */
export async function generateContext(
  chunk: RawChunk,
  fileRef: FileRef,
  cacheRef: CacheRef | null,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<string> {
  if (isLowQualityText(chunk.text)) {
    opts.logger.debug('Düşük kaliteli metin, context atlandı', {
      chunkLength: chunk.text.length,
      groupIndex: chunk.groupIndex
    })
    throw new Error('low-quality-text: context generation skipped')
  }

  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const response = await callWithRetry(async () => {
    if (cacheRef !== null) {
      return ai.models.generateContent({
        model: opts.model,
        contents: [
          {
            role: 'user',
            parts: [
              { text: chunk.text },
              { text: CONTEXT_SYSTEM_PROMPT }
            ]
          }
        ],
        config: { cachedContent: cacheRef.name }
      })
    } else {
      return ai.models.generateContent({
        model: opts.model,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } },
              { text: chunk.text },
              { text: CONTEXT_SYSTEM_PROMPT }
            ]
          }
        ]
      })
    }
  })

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const json = extractJson(rawText)
  const parsed = ContextSummarySchema.parse(JSON.parse(json))
  return parsed.contextSummary
}

/**
 * N chunk için tek API çağrısıyla context summary üretir.
 * Düşük kaliteli chunk'lar atlanır; karşılıkları null döner.
 * Dönüş array'i input chunks array'iyle birebir eşleşir.
 */
export async function generateContextBatch(
  chunks: RawChunk[],
  fileRef: FileRef,
  cacheRef: CacheRef | null,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(chunks.length).fill(null)

  const validItems = chunks
    .map((c, i) => ({ chunk: c, idx: i }))
    .filter(({ chunk }) => !isLowQualityText(chunk.text))

  if (validItems.length === 0) return results

  const chunkBlock = validItems
    .map(({ chunk }, pos) => `[PARÇA ${pos + 1}]\n${chunk.text}`)
    .join('\n\n---\n\n')

  const prompt = `global_referans: Tüm doküman. Bağlamı anlamak için kullan.
Aşağıda ${validItems.length} adet metin parçası var.
Her parça için TAM OLARAK 2 cümlelik bağlam özeti yaz.
Kural: Her özet, parça olmadan da bağlamı anlaşılır kılmalıdır.
ÇIKTI: Sadece JSON.
{ "summaries": ["<parça 1 özeti>", "<parça 2 özeti>"] }

${chunkBlock}`

  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const response = await callWithRetry(async () => {
    if (cacheRef !== null) {
      return ai.models.generateContent({
        model: opts.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { cachedContent: cacheRef.name }
      })
    } else {
      return ai.models.generateContent({
        model: opts.model,
        contents: [{
          role: 'user',
          parts: [
            { fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } },
            { text: prompt }
          ]
        }]
      })
    }
  })

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const parsed = BatchContextSchema.parse(JSON.parse(extractJson(rawText)))

  for (let i = 0; i < validItems.length; i++) {
    const summary = parsed.summaries[i]
    if (summary) results[validItems[i].idx] = summary
  }

  return results
}
