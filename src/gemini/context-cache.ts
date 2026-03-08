import { GoogleGenAI } from '@google/genai'
import type { FileRef, CacheRef } from '../types.js'
import type { ILogger } from '../logger.js'

export async function createCache(
  fileRef: FileRef,
  opts: { apiKey: string; model: string; logger: ILogger }
): Promise<CacheRef | null> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  try {
    const cache = await ai.caches.create({
      model: opts.model,
      config: {
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { mimeType: 'application/pdf', fileUri: fileRef.uri } }]
          }
        ],
        ttl: '86400s'
      }
    })

    opts.logger.info('Cache olusturuldu', { name: cache.name, expireTime: cache.expireTime })

    return {
      name: cache.name!,
      model: cache.model!,
      expireTime: cache.expireTime!
    }
  } catch (err) {
    opts.logger.warn('Context cache olusturulamadi, fileRef ile devam ediliyor', { error: err })
    return null
  }
}
