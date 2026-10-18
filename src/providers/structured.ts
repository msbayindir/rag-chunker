import type { z } from 'zod'
import { RagChunkerError } from '../errors.js'
import { extractJson, jsonSchemaOf } from './json.js'
import { addUsage, emptyUsage, type GenerateRequest, type LLM, type Usage } from './types.js'

export interface StructuredResult<T> {
  value: T
  usage: Usage
}

/**
 * Asks for JSON matching `schema` (native structured output where the provider supports it),
 * validates it with zod and retries once with a corrective note when the output is invalid.
 */
export async function generateJson<T>(
  llm: LLM,
  request: Omit<GenerateRequest, 'json'>,
  schema: z.ZodType<T>,
  name: string,
  options: { retries?: number } = {},
): Promise<StructuredResult<T>> {
  const spec = { name, schema: jsonSchemaOf(schema) }
  const usage = emptyUsage()
  const retries = options.retries ?? 1
  let lastError = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const parts =
      attempt === 0
        ? request.parts
        : [
            ...request.parts,
            {
              type: 'text' as const,
              text: `Your previous answer was not valid (${lastError}). Reply with JSON only, exactly matching the schema.`,
            },
          ]
    const res = await llm.generate({ ...request, parts, json: spec })
    addUsage(usage, res.usage)
    let parsed: unknown
    try {
      parsed = JSON.parse(extractJson(res.text))
    } catch (err) {
      lastError = `invalid JSON: ${(err as Error).message.slice(0, 120)}`
      continue
    }
    const result = schema.safeParse(parsed)
    if (result.success) return { value: result.data, usage }
    lastError = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
  }
  throw new RagChunkerError(
    'STRUCTURED_OUTPUT_FAILED',
    `${llm.ref} did not return valid JSON for ${name}: ${lastError}`,
    {
      hint: 'Try a larger or more capable model for this stage.',
    },
  )
}
