import { z } from 'zod'

/** Pulls the JSON value out of model text (handles ```json fences and leading prose). */
export function extractJson(raw: string): string {
  const text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? (fenced[1] as string) : text).trim()
  if (body.startsWith('{') || body.startsWith('[')) return body
  const obj = body.indexOf('{')
  const arr = body.indexOf('[')
  const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr)
  if (start === -1) return body
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  const end = body.lastIndexOf(close)
  return end > start ? body.slice(start, end + 1) : body.slice(start)
}

/** JSON Schema for a zod object, shaped for strict structured-output modes. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
  delete out.$schema
  return out
}
