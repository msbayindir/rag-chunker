import { totalmem } from 'node:os'
import { RagChunkerError } from '../errors.js'
import { ollamaListModels, ollamaModelInfo } from '../providers/ollama.js'
import { resolveProvider } from './providers.js'
import type { RagChunkerConfig } from './schema.js'

/** Gemma 4 tags from best to smallest, with the RAM (GB) they need to run comfortably. */
const GEMMA_PREFERENCE: Array<{ prefix: string; minRamGb: number }> = [
  { prefix: 'gemma4:31b', minRamGb: 40 },
  { prefix: 'gemma4:26b', minRamGb: 32 },
  { prefix: 'gemma4:12b', minRamGb: 20 },
  { prefix: 'gemma4:e4b', minRamGb: 12 },
  { prefix: 'gemma4:latest', minRamGb: 12 },
  { prefix: 'gemma4:e2b', minRamGb: 6 },
]
const EMBEDDING_PREFERENCE = [
  'embeddinggemma',
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'snowflake-arctic-embed',
]

/** Recommended Gemma 4 tag for this machine's memory. */
export function recommendedGemma(ramGb = totalmem() / 1024 ** 3): string {
  if (ramGb >= 40) return 'gemma4:26b-a4b-it-qat'
  if (ramGb >= 20) return 'gemma4:12b-it-qat'
  if (ramGb >= 10) return 'gemma4:e4b-it-qat'
  return 'gemma4:e2b-it-qat'
}

export const RECOMMENDED_EMBEDDING = 'embeddinggemma'

function base(name: string): string {
  return name.split(':')[0] as string
}

export interface LocalModels {
  llm: string | undefined
  embedding: string | undefined
  installed: string[]
}

/** Picks the best installed Ollama models for generation (vision) and embeddings. */
export async function detectLocalModels(
  env: Record<string, string | undefined>,
  config: RagChunkerConfig = {},
  ramGb = totalmem() / 1024 ** 3,
): Promise<LocalModels> {
  const provider = resolveProvider('ollama', config.providers?.ollama, env)
  if (!provider) throw new RagChunkerError('CONFIG_INVALID', 'Ollama provider is not available')
  const installed = await ollamaListModels(provider)
  let llm: string | undefined
  for (const pref of GEMMA_PREFERENCE) {
    if (pref.minRamGb > ramGb + 1) continue
    const hit = installed.find((m) => m.startsWith(pref.prefix))
    if (hit) {
      llm = hit
      break
    }
  }
  if (!llm) {
    for (const m of installed) {
      const info = await ollamaModelInfo(provider, m).catch(() => null)
      if (info?.capabilities.includes('vision') && info.capabilities.includes('completion')) {
        llm = m
        break
      }
    }
  }
  let embedding = EMBEDDING_PREFERENCE.map((p) => installed.find((m) => base(m) === p)).find(Boolean)
  if (!embedding) {
    for (const m of installed) {
      const info = await ollamaModelInfo(provider, m).catch(() => null)
      if (info?.capabilities.includes('embedding')) {
        embedding = m
        break
      }
    }
  }
  return { llm, embedding, installed }
}

/**
 * Config overrides for a fully local run: every stage on Ollama, OCR through the local vision model
 * (never Mistral, even when MISTRAL_API_KEY is set).
 */
export async function localPreset(
  env: Record<string, string | undefined>,
  config: RagChunkerConfig = {},
): Promise<RagChunkerConfig> {
  const { llm, embedding } = await detectLocalModels(env, config)
  if (!llm) {
    throw new RagChunkerError(
      'MODEL_NOT_FOUND',
      'No Gemma 4 (or other vision) model is installed in Ollama',
      {
        hint: `Run: ollama pull ${recommendedGemma()}`,
      },
    )
  }
  const ref = `ollama/${llm}`
  const models: NonNullable<RagChunkerConfig['models']> = { vision: ref, structure: ref, context: ref }
  if (embedding) models.embedding = `ollama/${embedding}`
  return { ocr: { engine: ref }, models, layout: { engine: 'pp-doclayout-v3' } }
}
