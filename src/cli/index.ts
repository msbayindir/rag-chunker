#!/usr/bin/env node
import { Command } from 'commander'
import { buildProcessCommand } from './commands/process.js'
import { buildOcrCommand } from './commands/ocr.js'
import { buildChunkCommand } from './commands/chunk.js'
import { buildInspectCommand } from './commands/inspect.js'
import { buildCacheCommand } from './commands/cache.js'

const program = new Command()
  .name('rag-chunker')
  .description('PDF OCR + deterministic AST chunker for RAG pipelines')
  .version('3.0.0')

program.addCommand(buildProcessCommand())
program.addCommand(buildOcrCommand())
program.addCommand(buildChunkCommand())
program.addCommand(buildInspectCommand())
program.addCommand(buildCacheCommand())

program.parse()
