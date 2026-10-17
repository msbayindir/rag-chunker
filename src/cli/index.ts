#!/usr/bin/env node
import { Command } from 'commander'
import { PACKAGE_VERSION } from '../output/manifest.js'
import { cacheCommand } from './commands/cache.js'
import { doctorCommand } from './commands/doctor.js'
import { evalCommand } from './commands/eval.js'
import { exportCommand } from './commands/export.js'
import { initCommand } from './commands/init.js'
import { inspectCommand } from './commands/inspect.js'
import { mcpCommand } from './commands/mcp.js'
import { processCommand } from './commands/process.js'

const program = new Command()
  .name('rag-chunker')
  .description('PDF, Office and Markdown → retrieval-ready chunks. Local (Ollama) or any cloud model.')
  .version(PACKAGE_VERSION, '-v, --version')
  .showHelpAfterError('(add --help for usage)')

program.addCommand(processCommand(), { isDefault: false })
program.addCommand(initCommand())
program.addCommand(doctorCommand())
program.addCommand(inspectCommand())
program.addCommand(evalCommand())
program.addCommand(exportCommand())
program.addCommand(mcpCommand())
program.addCommand(cacheCommand())

await program.parseAsync(process.argv)
