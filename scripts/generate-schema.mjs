// Writes schema/config.schema.json from the zod config schema (run after `tsc`).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { configSchema } = await import(join(root, 'dist', 'config', 'schema.js'))
const schema = z.toJSONSchema(configSchema, { target: 'draft-7', io: 'input', unrepresentable: 'any' })
schema.$id = 'https://unpkg.com/@msbayindir/rag-chunker@4/schema/config.schema.json'
schema.title = 'rag-chunker configuration'
await mkdir(join(root, 'schema'), { recursive: true })
await writeFile(join(root, 'schema', 'config.schema.json'), `${JSON.stringify(schema, null, 2)}\n`)
console.log('schema/config.schema.json written')
