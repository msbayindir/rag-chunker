import type { ResolvedProvider } from '../config/providers.js'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; mimeType: string }

export interface JsonSchemaSpec {
  name: string
  /** JSON Schema of an object (additionalProperties: false, every property required). */
  schema: Record<string, unknown>
}

export interface GenerateRequest {
  /** Instructions. */
  system?: string
  /**
   * Large, stable content shared by many requests (usually the document). Adapters put it first and
   * mark it cacheable: Anthropic cache_control, Gemini explicit caches, OpenAI/Ollama prefix reuse.
   */
  prefix?: string
  /** The per-request content that follows the prefix. */
  parts: ContentPart[]
  /** Ask for JSON that matches this schema. */
  json?: JsonSchemaSpec
  maxOutputTokens?: number
  /** Reasoning effort hint; providers without such a control ignore it. */
  effort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Input tokens served from a prompt cache (when the provider reports it). */
  cachedInputTokens: number
  requests: number
}

export interface GenerateResult {
  text: string
  usage: Usage
}

export interface ModelCapabilities {
  /** Usable context window in tokens (for Ollama: capped by maxContext). */
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
}

export interface LLM {
  /** "provider/model" */
  readonly ref: string
  readonly provider: ResolvedProvider
  readonly model: string
  generate(request: GenerateRequest): Promise<GenerateResult>
  capabilities(): Promise<ModelCapabilities>
  /** Releases server-side resources such as explicit caches. */
  dispose(): Promise<void>
}

export type EmbeddingKind = 'document' | 'query'

export interface Embedder {
  readonly ref: string
  readonly provider: ResolvedProvider
  readonly model: string
  /** Max input tokens per text. */
  maxInputTokens(): Promise<number>
  /** Preferred batch size per request. */
  readonly batchSize: number
  embed(
    texts: string[],
    kind: EmbeddingKind,
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; usage: Usage }>
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0 }
}

export function addUsage(target: Usage, add: Partial<Usage>): Usage {
  target.inputTokens += add.inputTokens ?? 0
  target.outputTokens += add.outputTokens ?? 0
  target.cachedInputTokens += add.cachedInputTokens ?? 0
  target.requests += add.requests ?? 0
  return target
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}
