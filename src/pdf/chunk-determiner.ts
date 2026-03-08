import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { PageGroup, RawChunk, FileRef, CacheRef } from '../types.js'
import type { ILogger } from '../logger.js'
import { callWithRetry, extractJson } from '../gemini/llm-caller.js'

const ChunkingOutputSchema = z.object({
  chunks: z.array(
    z.object({
      pages: z.array(z.number().int().positive()),
      text: z.string().min(1),
      contentHint: z.enum(['table', 'narrative', 'qa', 'mixed'])
    })
  )
})

type ParsedChunk = {
  pages: number[]
  text: string
  contentHint: 'table' | 'narrative' | 'qa' | 'mixed'
}

function buildChunkingPrompt(maxChunkChars: number): string {
  return `Sen bir belge analisti ve içerik yapılandırma uzmanısın.
global_referans: Tüm doküman bağlamını anlamak için kullan.
lokal_odak: Sadece bu sayfa grubunu işle, dışına çıkma.
Görev: Bu sayfaları mantıksal içerik birimlerine böl.
Kural: Tek konu, tablo, soru grubu veya paragraf grubu = 1 birim.
Kural: Yarım konu, yarım tablo, yarım soru BÖLME.
Kural: Her birimin metni eksiksiz ve bağımsız anlaşılabilir olmalı.
Kural: Her birimin metni ${maxChunkChars} karakteri GEÇMEMELİ. Uzun konuları birden fazla birime böl.
Her birim için: hangi sayfalar, metnin kendisi ve içerik tipi.
ÇIKTI: Sadece JSON.
{
  "chunks": [{
    "pages": [1, 2],
    "text": "...",
    "contentHint": "table | narrative | qa | mixed"
  }]
}`
}

/**
 * Gemini max karakter sınırını aşan chunk'ları paragraf sınırında böler.
 * Tüm alt parçalar orijinal chunk'ın sayfa listesini korur.
 */
function splitIfOversized(chunks: ParsedChunk[], maxChars: number): ParsedChunk[] {
  const result: ParsedChunk[] = []
  for (const c of chunks) {
    if (c.text.length <= maxChars) {
      result.push(c)
      continue
    }
    const paragraphs = c.text.split(/\n{2,}/)
    let current = ''
    for (const para of paragraphs) {
      if (current.length + para.length > maxChars && current.length > 0) {
        result.push({ pages: c.pages, text: current.trim(), contentHint: c.contentHint })
        current = para
      } else {
        current += (current ? '\n\n' : '') + para
      }
    }
    if (current.trim()) {
      result.push({ pages: c.pages, text: current.trim(), contentHint: c.contentHint })
    }
  }
  return result
}

/**
 * Gemini'ye 15 sayfalık grup + global bağlam göndererek chunk sınırlarını belirler.
 * Başarısız olursa throw eder (caller grubu error olarak işaretler).
 */
export async function determineChunks(
  group: PageGroup,
  groupIndex: number,
  fileRef: FileRef,
  cacheRef: CacheRef | null,
  opts: { apiKey: string; model: string; logger: ILogger; maxChunkChars: number }
): Promise<RawChunk[]> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const groupBase64 = Buffer.from(group.buffer).toString('base64')
  const prompt = buildChunkingPrompt(opts.maxChunkChars)

  const response = await callWithRetry(async () => {
    if (cacheRef !== null) {
      return ai.models.generateContent({
        model: opts.model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: groupBase64 } },
              { text: prompt }
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
              { inlineData: { mimeType: 'application/pdf', data: groupBase64 } },
              { text: prompt }
            ]
          }
        ]
      })
    }
  })

  const rawText = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const json = extractJson(rawText)
  const parsed = ChunkingOutputSchema.parse(JSON.parse(json))

  // Sorun 4: post-process — Gemini yine de büyük chunk döndürürse paragraf bazlı böl
  const splitChunks = splitIfOversized(parsed.chunks, opts.maxChunkChars)

  // Sorun 2: Gemini'nin LOCAL sayfa numaralarını ABSOLUTE'a çevir
  // Grup pageRange.start = 16 ise, Gemini'nin "1" dediği sayfa gerçekte 16'dır.
  const pageOffset = group.pageRange.start - 1

  return splitChunks.map(c => ({
    pages: c.pages.map(p => p + pageOffset),
    text: c.text,
    contentHint: c.contentHint,
    groupIndex
  }))
}
