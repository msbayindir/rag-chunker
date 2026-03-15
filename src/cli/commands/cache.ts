import { Command } from 'commander'
import {
  loadOcrRegistry,
  saveOcrRegistry,
  listOcrEntries,
  pruneOcrCache,
  clearOcrCache,
  formatCachedAt,
  DEFAULT_OCR_CACHE_PATH
} from '../../context/cache.js'

export function buildCacheCommand(): Command {
  const cmd = new Command('cache')
    .description('Manage the local OCR cache registry')

  cmd
    .command('list')
    .description('List all OCR cache entries')
    .option('--cache-path <path>', 'Custom cache JSON path', DEFAULT_OCR_CACHE_PATH)
    .action((opts: { cachePath: string }) => {
      const registry = loadOcrRegistry(opts.cachePath)
      const entries = listOcrEntries(registry)

      if (entries.length === 0) {
        process.stdout.write('OCR cache is empty.\n')
        return
      }

      process.stdout.write(`\nOCR cache (${entries.length} entries):\n`)
      for (const { key, entry } of entries) {
        process.stdout.write(
          `  ${key.slice(0, 16)}… | ${entry.model} | ${entry.pageCount} pages | ${formatCachedAt(entry.cachedAt)}\n`
        )
      }
      process.stdout.write('\n')
    })

  cmd
    .command('clear')
    .description('Clear OCR cache entries')
    .option('--expired', 'Remove only expired entries')
    .option('--all', 'Remove all entries')
    .option('--ttl <days>', 'TTL in days for expired check', '7')
    .option('--cache-path <path>', 'Custom cache JSON path', DEFAULT_OCR_CACHE_PATH)
    .action((opts: {
      expired?: boolean
      all?: boolean
      ttl: string
      cachePath: string
    }) => {
      if (!opts.expired && !opts.all) {
        process.stderr.write('Error: specify --expired or --all\n')
        globalThis.process.exit(1)
      }

      const registry = loadOcrRegistry(opts.cachePath)

      if (opts.all) {
        clearOcrCache(registry)
        saveOcrRegistry(opts.cachePath, registry)
        process.stdout.write('OCR cache cleared.\n')
        return
      }

      const ttlDays = parseFloat(opts.ttl)
      const removed = pruneOcrCache(registry, ttlDays)
      saveOcrRegistry(opts.cachePath, registry)
      process.stdout.write(`Removed ${removed} expired entries.\n`)
    })

  return cmd
}
