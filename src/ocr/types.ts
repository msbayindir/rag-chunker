export interface OcrPage {
  /** 1-indexed page number */
  pageNumber: number
  /** GFM markdown for this page */
  markdown: string
  /** OCR model that produced this page */
  model: string
}

export interface OcrResult {
  pages: OcrPage[]
  model: string
  pageCount: number
}
