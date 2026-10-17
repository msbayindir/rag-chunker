import { BUILTIN_PROVIDERS, type ResolvedProvider, resolveProvider } from '../config/providers.js'
import type { ResolvedConfig } from '../config/schema.js'
import { RagChunkerError } from '../errors.js'
import { AnthropicLLM } from './anthropic.js'
import { GeminiEmbedder, GeminiLLM } from './gemini.js'
import { OllamaEmbedder, OllamaLLM } from './ollama.js'
import { OpenAICompatibleEmbedder, OpenAICompatibleLLM } from './openai-compatible.js'
import type { Embedder, LLM } from './types.js'

export interface ProviderContext {
  config: ResolvedConfig
  env: Record<string, string | undefined>
}

/** Splits "provider/model" at the first slash. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1) {
    throw new RagChunkerError('CONFIG_INVALID', `Invalid model reference "${ref}"`, {
      hint: 'Use "provider/model", for example "ollama/gemma4:e4b-it-qat" or "gemini/gemini-3.8-flash".',
    })
  }
  return { provider: ref.slice(0, i).toLowerCase(), model: ref.slice(i + 1) }
}

export function getProvider(name: string, ctx: ProviderContext): ResolvedProvider {
  const provider = resolveProvider(name, ctx.config.providers[name], ctx.env)
  if (!provider) {
    throw new RagChunkerError('CONFIG_INVALID', `Unknown provider "${name}"`, {
      hint: `Built-in providers: ${Object.keys(BUILTIN_PROVIDERS).join(', ')}. For anything else add providers.${name}.type (and baseURL) to the config.`,
    })
  }
  return provider
}

function requireKey(provider: ResolvedProvider, ref: string): void {
  if (provider.local || provider.apiKey || provider.apiKeyEnv.length === 0) return
  throw new RagChunkerError('MISSING_API_KEY', `${ref} needs an API key`, {
    hint: `Set ${provider.apiKeyEnv.join(' or ')} in your environment or .env file.`,
  })
}

export function createLLM(ref: string, ctx: ProviderContext): LLM {
  const { provider: name, model } = parseModelRef(ref)
  const provider = getProvider(name, ctx)
  requireKey(provider, ref)
  switch (provider.type) {
    case 'anthropic':
      return new AnthropicLLM(provider, model)
    case 'gemini':
      return new GeminiLLM(provider, model)
    case 'ollama':
      return new OllamaLLM(provider, model)
    case 'openai':
    case 'openrouter':
    case 'openai-compatible':
    case 'mistral':
      return new OpenAICompatibleLLM(provider, model)
  }
}

export function createEmbedder(ref: string, ctx: ProviderContext): Embedder {
  const { provider: name, model } = parseModelRef(ref)
  const provider = getProvider(name, ctx)
  requireKey(provider, ref)
  const { dimensions, batchSize } = ctx.config.embedding
  switch (provider.type) {
    case 'gemini':
      return new GeminiEmbedder(provider, model, dimensions, batchSize)
    case 'ollama':
      return new OllamaEmbedder(provider, model, dimensions, batchSize)
    case 'openai':
    case 'openrouter':
    case 'openai-compatible':
    case 'mistral':
      return new OpenAICompatibleEmbedder(provider, model, dimensions, batchSize)
    case 'anthropic':
      throw new RagChunkerError('CAPABILITY_MISSING', `${ref}: Anthropic does not offer an embeddings API`, {
        hint: 'Pick an embedding model from another provider, e.g. ollama/embeddinggemma or openai/text-embedding-3-large.',
      })
  }
}

/** Creates providers on demand and shares instances within one run. */
export class ProviderRegistry {
  private readonly llms = new Map<string, LLM>()
  private readonly embedders = new Map<string, Embedder>()

  constructor(readonly ctx: ProviderContext) {}

  llm(ref: string): LLM {
    let llm = this.llms.get(ref)
    if (!llm) {
      llm = createLLM(ref, this.ctx)
      this.llms.set(ref, llm)
    }
    return llm
  }

  embedder(ref: string): Embedder {
    let e = this.embedders.get(ref)
    if (!e) {
      e = createEmbedder(ref, this.ctx)
      this.embedders.set(ref, e)
    }
    return e
  }

  provider(name: string): ResolvedProvider {
    return getProvider(name, this.ctx)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.llms.values()].map((l) => l.dispose().catch(() => {})))
  }
}
