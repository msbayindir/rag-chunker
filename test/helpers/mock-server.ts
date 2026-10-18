import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
  raw: string
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>

/** A tiny programmable HTTP server for provider tests. Routes match by "METHOD path-substring". */
export class MockServer {
  readonly requests: RecordedRequest[] = []
  private routes: Array<{ method: string; match: string | RegExp; handler: Handler; times?: number }> = []
  private server: Server
  url = ''

  constructor() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
        raw,
      }
      this.requests.push(rec)
      const route = this.routes.find(
        (r) =>
          (r.method === '*' || r.method === rec.method) &&
          (typeof r.match === 'string' ? rec.path.includes(r.match) : r.match.test(rec.path)),
      )
      if (!route) {
        json(res, 404, { error: `no route for ${rec.method} ${rec.path}` })
        return
      }
      if (route.times !== undefined) {
        route.times--
        if (route.times <= 0) this.routes.splice(this.routes.indexOf(route), 1)
      }
      try {
        await route.handler(rec, res)
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
    return this
  }

  /** Registers a route; earlier routes win. `times` limits how often it matches. */
  on(method: string, match: string | RegExp, handler: Handler, times?: number): this {
    this.routes.push({ method, match, handler, times })
    return this
  }

  /** Registers a route that wins over existing ones. */
  onFirst(method: string, match: string | RegExp, handler: Handler, times?: number): this {
    this.routes.unshift({ method, match, handler, times })
    return this
  }

  reset(): void {
    this.routes = []
    this.requests.length = 0
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export function sse(res: ServerResponse, events: Array<{ event: string; data: unknown }>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
  res.end()
}

/** Server-sent events for one Anthropic message with a single text block. */
export function anthropicStream(text: string, opts: { stopReason?: string; model?: string } = {}) {
  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: opts.model ?? 'claude-haiku-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
          },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: opts.stopReason ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]
}

export function openaiChat(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 8 },
    },
    ...extra,
  }
}
