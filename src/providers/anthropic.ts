import type Anthropic from '@anthropic-ai/sdk'
import type { ResolvedProvider } from '../config/providers.js'
import { RagChunkerError } from '../errors.js'
import { importOptional } from '../util/optional.js'
import { timeoutSignal, toProviderError, withRetry } from './retry.js'
import {
  emptyUsage,
  type GenerateRequest,
  type GenerateResult,
  type LLM,
  type ModelCapabilities,
  toBase64,
} from './types.js'

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/

type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export class AnthropicLLM implements LLM {
  readonly ref: string
  private client: Promise<Anthropic> | null = null
  private caps: Promise<ModelCapabilities> | null = null

  constructor(
    readonly provider: ResolvedProvider,
    readonly model: string,
  ) {
    this.ref = `${provider.name}/${model}`
  }

  private getClient(): Promise<Anthropic> {
    this.client ??= (async () => {
      const mod = await importOptional(
        '@anthropic-ai/sdk',
        'The Anthropic provider',
        () => import('@anthropic-ai/sdk'),
      )
      const AnthropicClass = mod.default
      return new AnthropicClass({
        apiKey: this.provider.apiKey,
        baseURL: this.provider.baseURL,
        defaultHeaders: this.provider.headers,
        maxRetries: 0,
        timeout: this.provider.timeoutMs,
      })
    })()
    return this.client
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.getClient()
    const system: Anthropic.TextBlockParam[] = []
    if (req.system) system.push({ type: 'text', text: req.system })
    // The document goes in a cached system block: every chunk request reuses it at ~10% of the cost.
    if (req.prefix) system.push({ type: 'text', text: req.prefix, cache_control: { type: 'ephemeral' } })

    const content: Anthropic.ContentBlockParam[] = req.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : {
            type: 'image',
            source: { type: 'base64', media_type: p.mimeType as ImageMime, data: toBase64(p.data) },
          },
    )

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.maxOutputTokens ?? 8192,
      messages: [{ role: 'user', content }],
      ...(system.length > 0 ? { system } : {}),
    }
    const outputConfig: Anthropic.OutputConfig = {}
    if (req.json) outputConfig.format = { type: 'json_schema', schema: req.json.schema }
    if (req.effort) outputConfig.effort = req.effort
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig

    const useFallbacks = FALLBACK_MODELS.test(this.model) && !this.provider.baseURL
    try {
      const message = await withRetry(
        async () => {
          const signal = timeoutSignal(this.provider.timeoutMs, req.signal)
          if (useFallbacks) {
            const stream = client.beta.messages.stream(
              {
                ...(params as unknown as Parameters<Anthropic['beta']['messages']['stream']>[0]),
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
              },
              { signal },
            )
            return (await stream.finalMessage()) as unknown as Anthropic.Message
          }
          return client.messages.stream(params, { signal }).finalMessage()
        },
        { maxRetries: this.provider.maxRetries, signal: req.signal },
      )
      if (message.stop_reason === 'refusal') {
        throw new RagChunkerError('PROVIDER_ERROR', `${this.ref}: the model declined this request`, {
          hint: 'Try a different model for this stage.',
        })
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const u = message.usage
      const cached = u.cache_read_input_tokens ?? 0
      return {
        text,
        usage: {
          ...emptyUsage(),
          inputTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cachedInputTokens: cached,
          requests: 1,
        },
      }
    } catch (err) {
      throw toProviderError(err, this.ref, this.provider.apiKeyEnv)
    }
  }

  capabilities(): Promise<ModelCapabilities> {
    this.caps ??= (async () => {
      const fallback: ModelCapabilities = {
        contextWindow: this.provider.contextWindow ?? 200_000,
        maxOutputTokens: 32_000,
        vision: true,
      }
      if (this.provider.contextWindow) return fallback
      try {
        const client = await this.getClient()
        const info = (await client.models.retrieve(this.model)) as unknown as {
          max_input_tokens?: number
          max_tokens?: number
        }
        return {
          contextWindow: info.max_input_tokens ?? fallback.contextWindow,
          maxOutputTokens: info.max_tokens ?? fallback.maxOutputTokens,
          vision: true,
        }
      } catch {
        return fallback
      }
    })()
    return this.caps
  }

  async dispose(): Promise<void> {}
}
