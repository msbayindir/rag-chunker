import { Command } from 'commander'
import pc from 'picocolors'
import { CacheStore } from '../../cache/store.js'
import { DEFAULT_CACHE_DIR, loadConfig } from '../../config/load.js'
import { err, formatNumber, parseIntOption, reportError, sym } from '../ui.js'

async function store(configPath?: string, dir?: string): Promise<CacheStore> {
  if (dir) return new CacheStore(dir)
  const { config } = await loadConfig({ configPath })
  return new CacheStore(config.cache.dir ?? DEFAULT_CACHE_DIR)
}

export function cacheCommand(): Command {
  const cmd = new Command('cache').description('Show or clear the cache (OCR pages, summaries, embeddings)')
  cmd
    .command('info')
    .description('Show cache size per stage')
    .option('--dir <dir>', 'cache folder (default from config or ~/.rag-chunker/cache)')
    .option('-c, --config <file>', 'config file')
    .action(async (flags: { dir?: string; config?: string }) => {
      try {
        const s = await store(flags.config, flags.dir)
        const stats = await s.stats()
        err()
        err(`  ${pc.bold('Cache')} ${pc.dim(s.dir ?? '')}`)
        err(`  ${formatNumber(stats.entries)} entries, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`)
        for (const [ns, v] of Object.entries(stats.namespaces).sort()) {
          err(
            `  ${sym.dot} ${ns.padEnd(10)} ${formatNumber(v.entries).padStart(7)} entries  ${(v.bytes / 1024 / 1024).toFixed(1)} MB`,
          )
        }
        err()
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
  cmd
    .command('clear')
    .description('Delete cache entries')
    .option('--older-than <days>', 'only entries older than this many days', parseIntOption('older-than'))
    .option('--dir <dir>', 'cache folder')
    .option('-c, --config <file>', 'config file')
    .action(async (flags: { olderThan?: number; dir?: string; config?: string }) => {
      try {
        const s = await store(flags.config, flags.dir)
        const removed = await s.prune(
          flags.olderThan === undefined ? undefined : flags.olderThan * 86_400_000,
        )
        err(`  ${sym.ok} Removed ${formatNumber(removed)} entr${removed === 1 ? 'y' : 'ies'}`)
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
  return cmd
}
