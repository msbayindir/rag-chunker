import { access, constants, mkdir } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { Command } from 'commander'
import pc from 'picocolors'
import { CacheStore } from '../../cache/store.js'
import { DEFAULT_CACHE_DIR, resolveConfig } from '../../config/load.js'
import { recommendedGemma } from '../../config/presets.js'
import { BUILTIN_PROVIDERS, resolveProvider } from '../../config/providers.js'
import type { ResolvedConfig } from '../../config/schema.js'
import { errorMessage, RagChunkerError } from '../../errors.js'
import { LAYOUT_MODEL } from '../../local/layout.js'
import { hasModel, MODELS, modelsDir } from '../../local/models.js'
import { PACKAGE_VERSION } from '../../output/manifest.js'
import { ollamaListModels } from '../../providers/ollama.js'
import { ProviderRegistry } from '../../providers/registry.js'
import { cliEnv } from '../env.js'
import { err, formatNumber, header, mask, reportError, sym } from '../ui.js'
import { buildConfig, type ProcessFlags } from './process.js'

type Status = 'ok' | 'warn' | 'fail' | 'info'
interface Check {
  status: Status
  label: string
  detail: string
  hint?: string
}

const icon = (s: Status) =>
  s === 'ok' ? sym.ok : s === 'warn' ? sym.warn : s === 'fail' ? sym.fail : sym.dot

async function canImport(loader: () => Promise<unknown>): Promise<boolean> {
  try {
    await loader()
    return true
  } catch {
    return false
  }
}

/** Collects environment, provider and model checks. Never throws. */
export async function runChecks(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
  configFile?: string,
): Promise<Check[]> {
  const checks: Check[] = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({
    status: major >= 22 ? 'ok' : 'fail',
    label: 'Node.js',
    detail: process.versions.node,
    hint: major >= 22 ? undefined : 'rag-chunker needs Node.js 22 or newer.',
  })
  checks.push({ status: 'info', label: 'Config', detail: configFile ?? 'none (defaults)' })

  const cacheDir = config.cache.dir ?? DEFAULT_CACHE_DIR
  if (config.cache.enabled) {
    try {
      await mkdir(cacheDir, { recursive: true })
      await access(cacheDir, constants.W_OK)
      const stats = await new CacheStore(cacheDir).stats()
      checks.push({
        status: 'ok',
        label: 'Cache',
        detail: `${cacheDir} ${pc.dim(`(${formatNumber(stats.entries)} entries, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB)`)}`,
      })
    } catch (e) {
      checks.push({
        status: 'fail',
        label: 'Cache',
        detail: `${cacheDir} is not writable`,
        hint: errorMessage(e),
      })
    }
  } else {
    checks.push({ status: 'info', label: 'Cache', detail: 'disabled' })
  }

  const canvas = await canImport(() => import('@napi-rs/canvas'))
  checks.push({
    status: canvas ? 'ok' : 'warn',
    label: 'Page rendering',
    detail: canvas ? '@napi-rs/canvas' : 'not available',
    hint: canvas ? undefined : 'Vision OCR of scanned PDF pages needs it: npm install @napi-rs/canvas',
  })

  const onnx = await canImport(() => import('onnxruntime-node'))
  const layoutModel = await hasModel(LAYOUT_MODEL)
  checks.push({
    status: onnx && layoutModel ? 'ok' : 'info',
    label: 'Layout model',
    detail: !onnx
      ? 'onnxruntime-node not installed'
      : layoutModel
        ? `${MODELS[LAYOUT_MODEL].file} in ${modelsDir(env)}`
        : 'onnxruntime-node ready, model not downloaded',
    hint: !onnx
      ? 'Page layout analysis (classes + reading order) needs it: npm install onnxruntime-node'
      : layoutModel
        ? undefined
        : 'Run `rag-chunker process <pdf> --layout` once to download PP-DocLayoutV3 (130 MB).',
  })

  for (const [name, def] of Object.entries(BUILTIN_PROVIDERS)) {
    if (def.local || name === 'google') continue
    const p = resolveProvider(name, config.providers[name], env)
    checks.push({
      status: p?.apiKey ? 'ok' : 'info',
      label: `${name} key`,
      detail: `${(def.apiKeyEnv ?? []).join(' / ')}: ${mask(p?.apiKey)}`,
    })
  }

  const ollama = resolveProvider('ollama', config.providers.ollama, env)
  if (ollama) {
    try {
      const models = await ollamaListModels(ollama)
      const gemma = models.filter((m) => m.startsWith('gemma4'))
      const embedders = models.filter((m) => /embed/i.test(m))
      checks.push({
        status: 'ok',
        label: 'Ollama',
        detail: `${ollama.baseURL} ${pc.dim(`(${models.length} model(s): ${models.slice(0, 6).join(', ')}${models.length > 6 ? ', …' : ''})`)}`,
      })
      if (gemma.length === 0) {
        checks.push({
          status: 'info',
          label: 'Gemma 4',
          detail: 'not installed',
          hint: `For --local: ollama pull ${recommendedGemma()}  (${Math.round(totalmem() / 1024 ** 3)} GB RAM detected)`,
        })
      }
      if (embedders.length === 0) {
        checks.push({
          status: 'info',
          label: 'Local embeddings',
          detail: 'none installed',
          hint: 'ollama pull embeddinggemma',
        })
      }
    } catch (e) {
      checks.push({
        status: 'info',
        label: 'Ollama',
        detail: `not reachable at ${ollama.baseURL}`,
        hint:
          e instanceof RagChunkerError
            ? e.hint
            : 'Install from https://ollama.com and start it to run models locally.',
      })
    }
  }

  // Configured models: metadata only (no paid generation requests).
  const registry = new ProviderRegistry({ config, env })
  const configured: Array<[string, string, 'llm' | 'embedding']> = []
  const { models, ocr } = config
  if (ocr.engine.includes('/')) configured.push(['ocr', ocr.engine, 'llm'])
  if (models.vision) configured.push(['vision', models.vision, 'llm'])
  if (models.structure) configured.push(['structure', models.structure, 'llm'])
  if (models.context) configured.push(['context', models.context, 'llm'])
  if (models.embedding) configured.push(['embedding', models.embedding, 'embedding'])
  if (ocr.engine === 'mistral' && !registry.provider('mistral').apiKey) {
    checks.push({
      status: 'fail',
      label: 'ocr',
      detail: 'mistral selected but no key',
      hint: 'Set MISTRAL_API_KEY',
    })
  }
  for (const [stage, ref, kind] of configured) {
    try {
      if (kind === 'llm') {
        const caps = await registry.llm(ref).capabilities()
        const needsVision = stage === 'ocr' || stage === 'vision'
        checks.push({
          status: needsVision && !caps.vision ? 'fail' : 'ok',
          label: stage,
          detail: `${ref} ${pc.dim(`(context ${formatNumber(caps.contextWindow)} tokens${caps.vision ? ', vision' : ''})`)}`,
          hint: needsVision && !caps.vision ? 'This stage needs a vision model.' : undefined,
        })
      } else {
        const limit = await registry.embedder(ref).maxInputTokens()
        checks.push({
          status: 'ok',
          label: stage,
          detail: `${ref} ${pc.dim(`(max input ${formatNumber(limit)} tokens)`)}`,
        })
      }
    } catch (e) {
      checks.push({
        status: 'fail',
        label: stage,
        detail: `${ref}: ${errorMessage(e)}`,
        hint: e instanceof RagChunkerError ? e.hint : undefined,
      })
    }
  }
  await registry.dispose()
  return checks
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check Node, cache, API keys, Ollama and the configured models')
    .option('-c, --config <file>', 'config file')
    .option('--local', 'also check the models --local would use')
    .option('--json', 'print the checks as JSON')
    .action(async (flags: Pick<ProcessFlags, 'config' | 'local'> & { json?: boolean }) => {
      try {
        const env = await cliEnv()
        let configInput: Awaited<ReturnType<typeof buildConfig>>
        try {
          configInput = await buildConfig({ config: flags.config, local: flags.local }, env)
        } catch (e) {
          if (!flags.local) throw e
          // --local without Gemma: still report everything else.
          configInput = await buildConfig({ config: flags.config }, env)
          err(`  ${sym.warn} ${pc.yellow(errorMessage(e))}`)
        }
        const config = resolveConfig(configInput.config)
        const checks = await runChecks(config, env, configInput.configFile)
        if (flags.json) {
          process.stdout.write(
            `${JSON.stringify(
              checks.map((c) => ({ ...c, detail: c.detail.replace(/\u001b\[\d+m/g, '') })),
              null,
              2,
            )}\n`,
          )
        } else {
          header(PACKAGE_VERSION)
          for (const c of checks) {
            err(`  ${icon(c.status)}  ${pc.bold(c.label.padEnd(16))} ${c.detail}`)
            if (c.hint) err(`     ${' '.repeat(16)} ${pc.dim(c.hint)}`)
          }
          err()
        }
        process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
}
