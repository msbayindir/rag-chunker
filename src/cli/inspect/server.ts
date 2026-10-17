import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PdfDocumentHandle } from '../../documents/pdf.js'
import { readOutputDir } from '../../output/writer.js'

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static')
const require = createRequire(import.meta.url)

const STATIC_FILES: Record<string, { file: () => string; type: string }> = {
  '/': { file: () => join(STATIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/static/style.css': { file: () => join(STATIC_DIR, 'style.css'), type: 'text/css; charset=utf-8' },
  '/static/app.js': { file: () => join(STATIC_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/static/marked.js': {
    file: () => join(dirname(require.resolve('marked')), 'marked.umd.js'),
    type: 'text/javascript; charset=utf-8',
  },
}

export interface InspectServer {
  url: string
  close(): Promise<void>
}

/** Serves the inspector UI for one output directory on 127.0.0.1. */
export async function startInspectServer(options: {
  dir: string
  pdf?: string
  port?: number
}): Promise<InspectServer> {
  const output = await readOutputDir(options.dir)
  const hasPdf = !!options.pdf && existsSync(options.pdf)
  // Pages are rendered to PNG on demand so the PDF view works in every browser (no PDF plugin needed).
  let pdfHandle: Promise<PdfDocumentHandle> | null = null
  const rendered = new Map<number, Promise<Uint8Array>>()
  const renderPage = (page: number): Promise<Uint8Array> => {
    let png = rendered.get(page)
    if (!png) {
      pdfHandle ??= readFile(options.pdf as string).then((b) => PdfDocumentHandle.open(new Uint8Array(b)))
      png = pdfHandle.then((h) => h.renderPng(page, 1400))
      png.catch(() => rendered.delete(page))
      rendered.set(page, png)
    }
    return png
  }
  // Vectors are large and not needed in the browser; keep only their length.
  const payload = JSON.stringify({
    manifest: output.manifest,
    structure: output.structure,
    markdown: output.markdown,
    chunks: output.chunks.map((c) => ({
      ...c,
      embedding: c.embedding.length ? new Array(c.embedding.length).fill(0) : [],
    })),
    hasPdf,
  })

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    try {
      if (path === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(payload)
        return
      }
      const pageMatch = /^\/api\/page\/(\d+)\.png$/.exec(path)
      if (pageMatch && hasPdf) {
        const png = await renderPage(Number(pageMatch[1]))
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' })
        res.end(png)
        return
      }
      if (path === '/api/pdf' && hasPdf) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end(await readFile(options.pdf as string))
        return
      }
      const asset = STATIC_FILES[path]
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff' })
        res.end(await readFile(asset.file()))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(e))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      if (pdfHandle) await (await pdfHandle).close()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}
