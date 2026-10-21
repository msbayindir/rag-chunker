import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command } from 'commander'
import { findConfigFile, loadConfigFile, resolveConfig } from '../../config/load.js'
import { RagChunkerError } from '../../errors.js'
import { lazyReranker, RERANKERS, resolveReranker } from '../../local/reranker.js'
import { createMcpServer } from '../../mcp/server.js'
import { readOutputDir } from '../../output/writer.js'
import { ProviderRegistry } from '../../providers/registry.js'
import { cliEnv } from '../env.js'
import { reportError } from '../ui.js'

export function mcpCommand(): Command {
  return new Command('mcp')
    .description(
      'Serve output folders to AI agents over MCP (stdio): search, get_chunk, get_page, list_documents',
    )
    .argument('<dirs...>', 'output folders written by `rag-chunker process`')
    .option('--embedding <model>', 'embed queries for hybrid search (default: the model in the manifest)')
    .option('--no-vectors', 'keyword search only')
    .option(
      '--rerank [model]',
      'reorder the top candidates with a reranker: the local model of local.profile (downloaded once) or cohere/… / jina/…',
    )
    .option('--no-rerank', 'no reranking even when the model is downloaded')
    .option(
      '--candidates <n>',
      'first-stage results handed to the reranker (default: rerank.candidates, 30); 15 halves the time of a search with bge-reranker-v2-m3 for a small loss',
    )
    .option('-c, --config <file>', 'config file')
    .addHelpText(
      'after',
      `
Claude Desktop / Claude Code config:
  { "mcpServers": { "docs": { "command": "npx", "args": ["-y", "@msbayindir/rag-chunker", "mcp", "/abs/path/to/output"] } } }`,
    )
    .action(
      async (
        dirs: string[],
        flags: {
          embedding?: string
          vectors?: boolean
          rerank?: string | boolean
          candidates?: string
          config?: string
        },
      ) => {
        try {
          const env = await cliEnv()
          const configFile = flags.config ?? findConfigFile()
          const config = resolveConfig(configFile ? await loadConfigFile(configFile) : undefined)
          const candidates = parseCandidates(flags.candidates, config.rerank.candidates)
          let embedder: ReturnType<ProviderRegistry['embedder']> | undefined
          if (flags.vectors !== false) {
            const first = await readOutputDir(dirs[0] as string)
            const model = flags.embedding ?? first.manifest.stages.embedding?.model
            if (model) embedder = new ProviderRegistry({ config, env }).embedder(model)
          }
          const plan = await resolveReranker(config, flags.rerank)
          // stdout carries the protocol; the download, when there is one, reports on stderr and
          // only starts with the first search, after the client has its handshake.
          let lastMb = -1
          const reranker = plan.ref
            ? new ProviderRegistry({ config, env }).reranker(plan.ref)
            : plan.id
              ? lazyReranker(plan.id, {
                  onModelDownload: (file, done, total) => {
                    const mb = Math.round(done / 1024 / 1024)
                    if (mb === lastMb && done < total) return
                    lastMb = mb
                    process.stderr.write(
                      `rag-chunker: downloading ${file} ${mb}/${Math.round(total / 1024 / 1024)} MB\n`,
                    )
                  },
                })
              : undefined
          if (plan.id && plan.download)
            process.stderr.write(
              `rag-chunker: the reranker ${plan.id} (${RERANKERS[plan.id].label}) is downloaded on the first search.\n`,
            )
          const server = await createMcpServer({
            dirs,
            embedder,
            reranker,
            candidates,
          })
          await server.connect(new StdioServerTransport())
        } catch (e) {
          process.exitCode = reportError(e)
        }
      },
    )
}

/** `--candidates` as a positive whole number, or the configured value when the flag is absent. */
export function parseCandidates(flag: string | undefined, fallback: number): number {
  if (flag === undefined) return fallback
  const n = Number(flag)
  if (!Number.isInteger(n) || n < 1) {
    throw new RagChunkerError(
      'CONFIG_INVALID',
      `--candidates must be a whole number of 1 or more, got "${flag}"`,
      {
        hint: 'The reranker scores this many first-stage results per search; 30 is the default, 15 halves the time.',
      },
    )
  }
  return n
}
