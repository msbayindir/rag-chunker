import { Command, Option } from 'commander'
import pc from 'picocolors'
import { CacheStore } from '../../cache/store.js'
import { DEFAULT_CACHE_DIR, findConfigFile, loadConfigFile, resolveConfig } from '../../config/load.js'
import { embedTexts } from '../../embeddings/embed.js'
import { RagChunkerError } from '../../errors.js'
import {
  type ExportResult,
  type ExportTarget,
  exportToLanceDb,
  exportToPgvector,
  exportToQdrant,
} from '../../export/export.js'
import { readOutputDir } from '../../output/writer.js'
import { ProviderRegistry } from '../../providers/registry.js'
import type { Chunk } from '../../types.js'
import { importOptional } from '../../util/optional.js'
import { cliEnv } from '../env.js'
import { err, formatNumber, reportError, sym } from '../ui.js'

interface ExportFlags {
  to: ExportTarget
  url?: string
  table?: string
  embedding?: string
  replaceDocument?: boolean
  index?: boolean
  config?: string
}

export function exportCommand(): Command {
  return new Command('export')
    .description('Write chunks and embeddings to pgvector, Qdrant or LanceDB')
    .argument('<dirs...>', 'output folders written by `rag-chunker process`')
    .addOption(
      new Option('--to <target>', 'destination')
        .choices(['pgvector', 'qdrant', 'lancedb'])
        .makeOptionMandatory(),
    )
    .option(
      '--url <url>',
      'pgvector: postgres:// URL (or DATABASE_URL) · qdrant: http URL (default http://127.0.0.1:6333) · lancedb: folder (default ./lancedb)',
    )
    .option('--table <name>', 'table / collection name (default rag_chunks)')
    .option('--embedding <model>', 'embed chunks now if the output has no embeddings')
    .option('--replace-document', 'remove chunks of the same document that are no longer produced')
    .option('--index', 'pgvector: create an HNSW index for cosine distance')
    .option('-c, --config <file>', 'config file')
    .action(async (dirs: string[], flags: ExportFlags) => {
      let registry: ProviderRegistry | undefined
      try {
        const env = await cliEnv()
        const configFile = flags.config ?? findConfigFile()
        const config = resolveConfig(configFile ? await loadConfigFile(configFile) : undefined)
        registry = new ProviderRegistry({ config, env })
        const cache = new CacheStore(config.cache.enabled ? (config.cache.dir ?? DEFAULT_CACHE_DIR) : null)

        for (const dir of dirs) {
          const o = await readOutputDir(dir)
          let chunks: Chunk[] = o.chunks
          if (flags.embedding && chunks.some((c) => c.embedding.length === 0)) {
            const res = await embedTexts(
              chunks.map((c) => c.content),
              {
                embedder: registry.embedder(flags.embedding),
                kind: 'document',
                cache,
                dimensions: config.embedding.dimensions,
              },
            )
            chunks = chunks.map((c, i) => ({ ...c, embedding: res.vectors[i] as number[] }))
          }
          let result: ExportResult
          if (flags.to === 'pgvector') {
            const url = flags.url ?? env.DATABASE_URL
            if (!url)
              throw new RagChunkerError('CONFIG_INVALID', 'pgvector export needs --url or DATABASE_URL')
            const pg = await importOptional('pg', 'Exporting to Postgres', () => import('pg'))
            const client = new pg.default.Client({ connectionString: url })
            await client.connect()
            try {
              result = await exportToPgvector(client, chunks, {
                table: flags.table,
                replaceDocument: flags.replaceDocument,
                createIndex: flags.index,
              })
            } finally {
              await client.end()
            }
          } else if (flags.to === 'qdrant') {
            result = await exportToQdrant(chunks, {
              url: flags.url ?? env.QDRANT_URL ?? 'http://127.0.0.1:6333',
              collection: flags.table,
              apiKey: env.QDRANT_API_KEY,
              replaceDocument: flags.replaceDocument,
            })
          } else {
            result = await exportToLanceDb(chunks, {
              uri: flags.url ?? './lancedb',
              table: flags.table,
              replaceDocument: flags.replaceDocument,
            })
          }
          err(
            `  ${sym.ok} ${pc.bold(o.manifest.source.name)} → ${result.location} ${pc.dim(`(${formatNumber(result.written)} chunks, ${result.dimensions} dims${result.deleted ? `, ${result.deleted} stale removed` : ''})`)}`,
          )
        }
      } catch (e) {
        process.exitCode = reportError(e)
      } finally {
        await registry?.dispose()
      }
    })
}
