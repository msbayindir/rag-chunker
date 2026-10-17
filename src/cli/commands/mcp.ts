import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Command } from 'commander'
import { findConfigFile, loadConfigFile, resolveConfig } from '../../config/load.js'
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
    .option('-c, --config <file>', 'config file')
    .addHelpText(
      'after',
      `
Claude Desktop / Claude Code config:
  { "mcpServers": { "docs": { "command": "npx", "args": ["-y", "@msbayindir/rag-chunker", "mcp", "/abs/path/to/output"] } } }`,
    )
    .action(async (dirs: string[], flags: { embedding?: string; vectors?: boolean; config?: string }) => {
      try {
        const env = await cliEnv()
        const configFile = flags.config ?? findConfigFile()
        const config = resolveConfig(configFile ? await loadConfigFile(configFile) : undefined)
        let embedder: ReturnType<ProviderRegistry['embedder']> | undefined
        if (flags.vectors !== false) {
          const first = await readOutputDir(dirs[0] as string)
          const model = flags.embedding ?? first.manifest.stages.embedding?.model
          if (model) embedder = new ProviderRegistry({ config, env }).embedder(model)
        }
        const server = await createMcpServer({ dirs, embedder })
        // stdout carries the protocol; nothing else may be written there.
        await server.connect(new StdioServerTransport())
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
}
