import { PDFDocument } from 'pdf-lib'

export const MISTRAL_MAX_BYTES = 50 * 1024 * 1024   // 50 MB hard limit
const SPLIT_TARGET_BYTES      = 40 * 1024 * 1024   // 40 MB per chunk (safety margin)

export interface PdfChunk {
  buffer: Buffer
  /** 0-based index of first page in the original document */
  pageOffset: number
  pageCount: number
}

/**
 * Splits a PDF buffer into chunks that fit within SPLIT_TARGET_BYTES.
 * Page numbers in each chunk start from 1; use `pageOffset` to reconstruct
 * absolute page numbers when merging OCR results.
 */
export async function splitPdf(pdfBuffer: Buffer): Promise<PdfChunk[]> {
  const srcDoc = await PDFDocument.load(pdfBuffer)
  const totalPages = srcDoc.getPageCount()
  const bytesPerPage = pdfBuffer.length / totalPages
  const pagesPerChunk = Math.max(1, Math.floor(SPLIT_TARGET_BYTES / bytesPerPage))

  const chunks: PdfChunk[] = []

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages)
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i)

    const chunkDoc = await PDFDocument.create()
    const copied = await chunkDoc.copyPages(srcDoc, pageIndices)
    copied.forEach((p: import('pdf-lib').PDFPage) => chunkDoc.addPage(p))

    chunks.push({
      buffer: Buffer.from(await chunkDoc.save()),
      pageOffset: start,
      pageCount: end - start
    })
  }

  return chunks
}
