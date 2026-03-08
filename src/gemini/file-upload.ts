import { GoogleGenAI } from '@google/genai'
import type { FileRef } from '../types.js'
import type { ILogger } from '../logger.js'

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
