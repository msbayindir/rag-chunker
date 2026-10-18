import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDotEnv } from '../../src/config/load.js'
import { normalizeOllamaHost } from '../../src/config/providers.js'

const root = join(fileURLToPath(import.meta.url), '..', '..', '..')

/** process.env plus the repository's .env (real environment wins). */
export async function liveEnv(): Promise<Record<string, string | undefined>> {
  return { ...(await readDotEnv(join(root, '.env'))), ...process.env }
}

export async function ollamaModels(env: Record<string, string | undefined>): Promise<string[] | null> {
  const host = normalizeOllamaHost(env.OLLAMA_HOST) ?? 'http://127.0.0.1:11434'
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = (await res.json()) as { models: Array<{ name: string }> }
    return body.models.map((m) => m.name)
  } catch {
    return null
  }
}
