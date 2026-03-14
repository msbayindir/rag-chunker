#!/usr/bin/env node
import { Command } from 'commander'
import { buildProcessCommand } from './commands/process.js'
import { buildInspectCommand } from './commands/inspect.js'
import { buildCacheCommand } from './commands/cache.js'

const program = new Command()
  .name('rag-chunker')
  .description('PDF semantic chunker for RAG pipelines')
  .version('2.0.0')

program.addCommand(buildProcessCommand())
program.addCommand(buildInspectCommand())
program.addCommand(buildCacheCommand())

program.parse()
