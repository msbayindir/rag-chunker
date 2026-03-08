import { PDFDocument } from 'pdf-lib'
import type { PageGroup } from '../types.js'

function range(start: number, end: number): number[] {
  const result: number[] = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

export async function splitIntoGroups(
  buffer: Buffer | Uint8Array,
  opts: {
    groupSize?: number
    pageRange?: { start: number; end: number }
    maxPages?: number
  }
): Promise<PageGroup[]> {
  const doc = await PDFDocument.load(buffer)
  const totalPages = doc.getPageCount()

  let startIdx = 0
  let endIdx = totalPages - 1

  if (opts.pageRange) {
    startIdx = Math.max(0, opts.pageRange.start - 1)
    endIdx = Math.min(totalPages - 1, opts.pageRange.end - 1)
  }
  if (opts.maxPages) {
    endIdx = Math.min(endIdx, startIdx + opts.maxPages - 1)
  }

  const selectedIndices = range(startIdx, endIdx)

  const size = opts.groupSize ?? 15
  const groups = chunkArray(selectedIndices, size)

  const pageGroups: PageGroup[] = []
  for (const pageIndices of groups) {
    const newDoc = await PDFDocument.create()
    const copied = await newDoc.copyPages(doc, pageIndices)
    for (const page of copied) newDoc.addPage(page)
    const bytes = await newDoc.save()

    const firstPage = pageIndices[0]! + 1
    const lastPage = pageIndices[pageIndices.length - 1]! + 1
    pageGroups.push({
      pageRange: { start: firstPage, end: lastPage },
      buffer: bytes
    })
  }

  return pageGroups
}
