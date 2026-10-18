import type { ProviderConfig, ProviderType } from './schema.js'

export interface BuiltinProvider {
  type: ProviderType
  baseURL?: string
  apiKeyEnv?: string[]
  /** True when the provider runs locally and needs no key. */
  local?: boolean
}

/** Provider names that work without any `providers` entry in the config. */
export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  openai: { type: 'openai', apiKeyEnv: ['OPENAI_API_KEY'] },
  openrouter: {
    type: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
  },
  anthropic: { type: 'anthropic', apiKeyEnv: ['ANTHROPIC_API_KEY'] },
  gemini: { type: 'gemini', apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  google: { type: 'gemini', apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  ollama: { type: 'ollama', local: true },
  mistral: { type: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: ['MISTRAL_API_KEY'] },
  cohere: { type: 'cohere', baseURL: 'https://api.cohere.com/v2', apiKeyEnv: ['COHERE_API_KEY'] },
  jina: { type: 'jina', baseURL: 'https://api.jina.ai/v1', apiKeyEnv: ['JINA_API_KEY'] },
  lmstudio: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', local: true },
}

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434'

export interface ResolvedProvider {
  name: string
  type: ProviderType
  baseURL: string | undefined
  apiKey: string | undefined
  apiKeyEnv: string[]
  headers: Record<string, string>
  contextWindow: number | undefined
  maxContext: number
  concurrency: number
  timeoutMs: number
  maxRetries: number
  local: boolean
}

const DEFAULT_CONCURRENCY: Record<ProviderType, number> = {
  ollama: 1,
  'openai-compatible': 2,
  openai: 4,
  openrouter: 4,
  anthropic: 4,
  gemini: 4,
  mistral: 2,
  cohere: 4,
  jina: 4,
}

/** Merges a built-in provider definition, user config and environment into a usable provider. */
export function resolveProvider(
  name: string,
  user: ProviderConfig | undefined,
  env: Record<string, string | undefined>,
): ResolvedProvider | undefined {
  const builtin = BUILTIN_PROVIDERS[name]
  const type = user?.type ?? builtin?.type
  if (!type) return undefined

  const apiKeyEnv = user?.apiKeyEnv ? [user.apiKeyEnv] : (builtin?.apiKeyEnv ?? [])
  const apiKey = user?.apiKey ?? apiKeyEnv.map((k) => env[k]).find((v) => v !== undefined && v.trim() !== '')
  let baseURL = user?.baseURL ?? builtin?.baseURL
  if (type === 'ollama' && !baseURL) baseURL = normalizeOllamaHost(env.OLLAMA_HOST) ?? DEFAULT_OLLAMA_HOST
  const local = builtin?.local ?? (type === 'ollama' || isLocalUrl(baseURL))

  return {
    name,
    type,
    baseURL,
    apiKey: apiKey?.trim(),
    apiKeyEnv,
    headers: user?.headers ?? {},
    contextWindow: user?.contextWindow,
    maxContext: user?.maxContext ?? 32768,
    concurrency: user?.concurrency ?? DEFAULT_CONCURRENCY[type],
    timeoutMs: user?.timeoutMs ?? (local ? 600_000 : 180_000),
    maxRetries: user?.maxRetries ?? 4,
    local,
  }
}

/** Accepts OLLAMA_HOST values like "0.0.0.0", "localhost:11434" or "http://host:port". */
export function normalizeOllamaHost(value: string | undefined): string | undefined {
  if (!value || value.trim() === '') return undefined
  let v = value.trim()
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`
  try {
    const url = new URL(v)
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    if (!url.port && url.protocol === 'http:') url.port = '11434'
    return url.origin
  } catch {
    return undefined
  }
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
  } catch {
    return false
  }
}
