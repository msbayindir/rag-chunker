import { GoogleGenAI } from '@google/genai'
import type { FileRef, CacheRef } from '../types.js'
import type { ILogger } from '../logger.js'
import { callWithRetry } from './llm-caller.js'

/**
 * Uploads a PDF buffer to the Gemini Files API.
 * Returns a FileRef with the file name and URI for subsequent API calls.
 */
export async function uploadPdf(
  buffer: Buffer | Uint8Array,
  opts: { apiKey: string; logger: ILogger }
): Promise<FileRef> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const startTime = Date.now()
  opts.logger.info('PDF yukleniyor', { bytes: buffer.byteLength })

  const blob = new Blob([buffer], { type: 'application/pdf' })
  const uploaded = await ai.files.upload({ file: blob, config: { mimeType: 'application/pdf' } })

  const durationMs = Date.now() - startTime
  opts.logger.info('PDF yuklendi', { name: uploaded.name, durationMs })

  return {
    name: uploaded.name!,
    uri: uploaded.uri!,
    mimeType: uploaded.mimeType ?? 'application/pdf'
  }
}

/**
 * Creates a Gemini context cache for the given file.
 * Returns null on failure (caller falls back to fileRef-based requests).
 */
export async function createCache(
  fileRef: FileRef,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<CacheRef | null> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  try {
    const cache = await callWithRetry(() => ai.caches.create({
      model: opts.model,
      config: {
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } }]
          }
        ],
        ttl: '3600s'
      }
    }))

    opts.logger.info('Cache olusturuldu', { name: cache.name, expireTime: cache.expireTime })

    return {
      name: cache.name!,
      model: cache.model!,
      expireTime: cache.expireTime!
    }
  } catch (err) {
    opts.logger.warn('Context cache olusturulamadi, fileRef ile devam ediliyor', { err })
    return null
  }
}
