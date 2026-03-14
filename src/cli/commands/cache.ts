import { Command } from 'commander'
import {
  loadRegistry, saveRegistry, formatRemaining, DEFAULT_REGISTRY_PATH
} from '../../context/cache-manager.js'

export function buildCacheCommand(): Command {
  const cmd = new Command('cache')
    .description('Manage the local file/cache registry')

  cmd
    .command('list')
    .description('List all registry entries')
    .option('--registry <path>', 'Custom registry JSON path', DEFAULT_REGISTRY_PATH)
    .action((opts: { registry: string }) => {
      const registry = loadRegistry(opts.registry)

      const files = Object.entries(registry.files)
      const caches = Object.entries(registry.caches)

      if (files.length === 0 && caches.length === 0) {
        process.stdout.write('Registry is empty.\n')
        return
      }

      if (files.length > 0) {
        process.stdout.write(`\nFiles (${files.length}):\n`)
        for (const [hash, entry] of files) {
          process.stdout.write(
            `  ${hash.slice(0, 12)}… → ${entry.name} | ${formatRemaining(entry.expiresAt)}\n`
          )
        }
      }

      if (caches.length > 0) {
        process.stdout.write(`\nCaches (${caches.length}):\n`)
        for (const [key, entry] of caches) {
          process.stdout.write(
            `  ${key.slice(0, 20)}… | model: ${entry.model} | ${formatRemaining(entry.expireTime)}\n`
          )
        }
      }
      process.stdout.write('\n')
    })

  cmd
    .command('clear')
    .description('Clear registry entries')
    .option('--expired', 'Remove only expired entries')
    .option('--all', 'Remove all entries')
    .option('--registry <path>', 'Custom registry JSON path', DEFAULT_REGISTRY_PATH)
    .action((opts: { expired?: boolean; all?: boolean; registry: string }) => {
      if (!opts.expired && !opts.all) {
        process.stderr.write('Error: specify --expired or --all\n')
        globalThis.process.exit(1)
      }

      const registry = loadRegistry(opts.registry)

      if (opts.all) {
        registry.files = {}
        registry.caches = {}
        saveRegistry(opts.registry, registry)
        process.stdout.write('Registry cleared.\n')
        return
      }

      // --expired: remove entries where expiry has passed
      const now = Date.now()
      let removed = 0

      for (const k of Object.keys(registry.files)) {
        if (new Date(registry.files[k]!.expiresAt).getTime() <= now) {
          delete registry.files[k]
          removed++
        }
      }
      for (const k of Object.keys(registry.caches)) {
        if (new Date(registry.caches[k]!.expireTime).getTime() <= now) {
          delete registry.caches[k]
          removed++
        }
      }

      saveRegistry(opts.registry, registry)
      process.stdout.write(`Removed ${removed} expired entries.\n`)
    })

  return cmd
}
