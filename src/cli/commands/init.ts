import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { RECOMMENDED_EMBEDDING, recommendedGemma } from '../../config/presets.js'
import { resolveProvider } from '../../config/providers.js'
import type { RagChunkerConfig } from '../../config/schema.js'
import { RagChunkerError } from '../../errors.js'
import { PACKAGE_VERSION } from '../../output/manifest.js'
import { ollamaListModels } from '../../providers/ollama.js'
import { importOptional } from '../../util/optional.js'
import { cliEnv } from '../env.js'
import { err, header, reportError, sym } from '../ui.js'

const SCHEMA_URL = 'https://unpkg.com/@msbayindir/rag-chunker@4/schema/config.schema.json'

function schemaRef(cwd: string): string {
  const local = join(cwd, 'node_modules', '@msbayindir', 'rag-chunker', 'schema', 'config.schema.json')
  return existsSync(local) ? './node_modules/@msbayindir/rag-chunker/schema/config.schema.json' : SCHEMA_URL
}

export type Setup = 'local' | 'gemini' | 'anthropic' | 'openai' | 'openrouter' | 'text'

/** Default config for each setup. Cloud model ids are suggestions and can be edited later. */
export function configFor(
  setup: Setup,
  opts: { gemma?: string; embedding?: string; mistral?: boolean } = {},
): RagChunkerConfig {
  const gemma = `ollama/${opts.gemma ?? recommendedGemma()}`
  const localEmbedding = `ollama/${opts.embedding ?? RECOMMENDED_EMBEDDING}`
  const ocr = opts.mistral ? { engine: 'mistral' } : undefined
  switch (setup) {
    case 'local':
      return {
        ocr: { engine: gemma },
        models: { vision: gemma, structure: gemma, context: gemma, embedding: localEmbedding },
      }
    case 'gemini':
      return {
        ...(ocr ? { ocr } : {}),
        models: {
          vision: 'gemini/gemini-3.8-flash',
          structure: 'gemini/gemini-3.8-flash',
          context: 'gemini/gemini-3.5-flash-lite',
          embedding: 'gemini/gemini-embedding-001',
        },
      }
    case 'anthropic':
      return {
        ...(ocr ? { ocr } : {}),
        models: {
          vision: 'anthropic/claude-haiku-5-5',
          structure: 'anthropic/claude-sonnet-5-5',
          context: 'anthropic/claude-haiku-5-5',
          embedding: localEmbedding,
        },
      }
    case 'openai':
      return {
        ...(ocr ? { ocr } : {}),
        models: { embedding: 'openai/text-embedding-3-large' },
      }
    case 'openrouter':
      return {
        ...(ocr ? { ocr } : {}),
        models: {
          vision: 'openrouter/anthropic/claude-haiku-5-5',
          structure: 'openrouter/anthropic/claude-haiku-5-5',
          context: 'openrouter/anthropic/claude-haiku-5-5',
        },
      }
    case 'text':
      return { ocr: { engine: opts.mistral ? 'mistral' : 'text-layer' } }
  }
}

async function pullModel(host: string, model: string): Promise<void> {
  const { Ollama } = await importOptional('ollama', 'Pulling Ollama models', () => import('ollama'))
  const client = new Ollama({ host })
  const stream = await client.pull({ model, stream: true })
  let last = -1
  for await (const part of stream) {
    if (part.total && part.completed) {
      const pct = Math.floor((part.completed / part.total) * 100)
      if (pct !== last && pct % 5 === 0) {
        process.stderr.write(`\r     ${model}: ${pct}%   `)
        last = pct
      }
    }
  }
  process.stderr.write(`\r     ${model}: done       \n`)
}

export function initCommand(): Command {
  return new Command('init')
    .description('Create rag-chunker.config.json with a guided setup')
    .option('-y, --yes', 'accept the recommended setup without questions')
    .option('--force', 'overwrite an existing config file')
    .action(async (flags: { yes?: boolean; force?: boolean }) => {
      try {
        header(PACKAGE_VERSION)
        const cwd = process.cwd()
        const target = join(cwd, 'rag-chunker.config.json')
        if (existsSync(target) && !flags.force) {
          throw new RagChunkerError('CONFIG_INVALID', 'rag-chunker.config.json already exists', {
            hint: 'Use --force to overwrite it.',
          })
        }
        const env = await cliEnv(cwd)
        const ollama = resolveProvider('ollama', undefined, env)
        const installed = ollama ? await ollamaListModels(ollama).catch(() => null) : null
        const ramGb = Math.round(totalmem() / 1024 ** 3)
        const keys = {
          mistral: !!env.MISTRAL_API_KEY,
          gemini: !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
          anthropic: !!env.ANTHROPIC_API_KEY,
          openai: !!env.OPENAI_API_KEY,
          openrouter: !!env.OPENROUTER_API_KEY,
        }
        err(
          `  ${sym.dot} RAM ${ramGb} GB ${sym.dot} Ollama ${installed ? pc.green('running') : pc.dim('not found')}`,
        )
        err(
          `  ${sym.dot} Keys: ${Object.entries(keys)
            .map(([k, v]) => (v ? pc.green(k) : pc.dim(k)))
            .join(' ')}`,
        )
        err()

        const recommended: Setup = installed
          ? 'local'
          : keys.gemini
            ? 'gemini'
            : keys.anthropic
              ? 'anthropic'
              : keys.openrouter
                ? 'openrouter'
                : 'text'
        let setup: Setup = recommended
        let useMistral = keys.mistral && recommended !== 'local'
        let gemma = installed?.find((m) => m.startsWith('gemma4')) ?? recommendedGemma(ramGb)
        let embedding = installed?.find((m) => m.startsWith('embeddinggemma')) ?? RECOMMENDED_EMBEDDING

        if (!flags.yes) {
          if (!process.stdin.isTTY) {
            throw new RagChunkerError('CONFIG_INVALID', 'init needs an interactive terminal', {
              hint: 'Run `rag-chunker init --yes` to use the recommended setup.',
            })
          }
          const { select, confirm } = await import('@inquirer/prompts')
          setup = await select<Setup>({
            message: 'How do you want to run rag-chunker?',
            default: recommended,
            choices: [
              { value: 'local', name: 'Fully local with Ollama (Gemma 4) — nothing leaves this machine' },
              { value: 'gemini', name: 'Google Gemini' },
              { value: 'anthropic', name: 'Anthropic Claude (+ local embeddings)' },
              { value: 'openrouter', name: 'OpenRouter (one key, many models)' },
              { value: 'openai', name: 'OpenAI (embeddings; add chat models yourself)' },
              { value: 'text', name: 'No AI: text layer + chunking only' },
            ],
          })
          if (setup !== 'local' && keys.mistral) {
            useMistral = await confirm({
              message: 'Use Mistral OCR for PDFs (best quality, ~$1-2 per 1000 pages)?',
              default: true,
            })
          }
          if (setup === 'local' || setup === 'anthropic') {
            const wanted = setup === 'local' ? [gemma, embedding] : [embedding]
            const missing = wanted.filter((m) => !installed?.some((i) => i === m || i.startsWith(`${m}:`)))
            if (missing.length > 0) {
              if (!installed || !ollama) {
                err(
                  `  ${sym.warn} ${pc.yellow('Ollama is not running. Install it from https://ollama.com, then run:')}`,
                )
                for (const m of missing) err(`     ollama pull ${m}`)
              } else if (
                await confirm({ message: `Download ${missing.join(' and ')} now?`, default: true })
              ) {
                for (const m of missing) await pullModel(ollama.baseURL as string, m)
              }
            }
          }
        }
        if (!installed?.some((m) => m === gemma)) gemma = recommendedGemma(ramGb)
        if (!installed?.some((m) => m.startsWith(embedding))) embedding = RECOMMENDED_EMBEDDING

        const config = {
          $schema: schemaRef(cwd),
          ...configFor(setup, { gemma, embedding, mistral: useMistral }),
        }
        await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
        err(
          `  ${sym.ok} Wrote ${pc.bold('rag-chunker.config.json')} ${pc.dim(`(${setup}${useMistral ? ' + Mistral OCR' : ''})`)}`,
        )
        if (setup !== 'local' && setup !== 'text') {
          err(
            `     ${pc.dim('Model ids are suggestions — edit them to the models you want. Keys go in .env, never in the config.')}`,
          )
        }
        err()
        err(
          `  Next: ${pc.cyan('npx @msbayindir/rag-chunker doctor')}  then  ${pc.cyan('npx @msbayindir/rag-chunker process <file>')}`,
        )
        err()
      } catch (e) {
        process.exitCode = reportError(e)
      }
    })
}
