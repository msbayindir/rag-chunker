// npx @msbayindir/rag-chunker export out --to pgvector --url $DATABASE_URL
// node examples/pgvector-query.mjs "question"

import { embedQuery } from '@msbayindir/rag-chunker'
import pg from 'pg'

const question = process.argv[2] ?? 'hiponatremi tedavisi'
const vector = await embedQuery(question, 'ollama/embeddinggemma') // same model as the chunks
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const { rows } = await client.query(
  `SELECT source, page_start, section_path, raw_content, embedding <=> $1 AS distance
     FROM rag_chunks ORDER BY embedding <=> $1 LIMIT 5`,
  [`[${vector.join(',')}]`],
)
for (const r of rows)
  console.log(`${r.distance.toFixed(3)}  ${r.source} p${r.page_start}  ${r.section_path.join(' › ')}`)
await client.end()
