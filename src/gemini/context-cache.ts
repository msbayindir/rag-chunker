import { GoogleGenAI } from '@google/genai'
import type { FileRef, CacheRef } from '../types.js'
import type { ILogger } from '../logger.js'
import { callWithRetry } from './llm-caller.js'

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
