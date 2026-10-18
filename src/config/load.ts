import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { RagChunkerError } from '../errors.js'
import { configSchema, type RagChunkerConfig, type ResolvedConfig } from './schema.js'

export const CONFIG_FILE_NAMES = [
  'rag-chunker.config.json',
  'rag-chunker.config.mjs',
  'rag-chunker.config.js',
] as const

export const DEFAULT_CACHE_DIR = join(homedir(), '.rag-chunker', 'cache')

/** Returns the first config file found in `cwd`, or undefined. */
export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Loads and validates a config file. Keys are rejected: they belong in environment variables. */
export async function loadConfigFile(path: string): Promise<RagChunkerConfig> {
  const abs = resolve(path)
  if (!existsSync(abs)) {
    throw new RagChunkerError('CONFIG_INVALID', `Config file not found: ${abs}`)
  }
  let raw: unknown
  if (abs.endsWith('.json')) {
    const text = await readFile(abs, 'utf8')
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new RagChunkerError('CONFIG_INVALID', `${abs} is not valid JSON: ${(err as Error).message}`)
    }
  } else {
    const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown }
    raw = mod.default
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RagChunkerError('CONFIG_INVALID', `${abs} must export an object`)
  }
  const providers = (raw as { providers?: Record<string, { apiKey?: unknown }> }).providers
  if (providers && typeof providers === 'object') {
    for (const [name, p] of Object.entries(providers)) {
      if (p && typeof p === 'object' && 'apiKey' in p) {
        throw new RagChunkerError(
          'CONFIG_INVALID',
          `providers.${name}.apiKey is not allowed in config files`,
          {
            hint: 'Put the key in an environment variable (or .env) instead; config files are often committed.',
          },
        )
      }
    }
  }
  // Validate early so the error points at the file.
  parseConfig(raw, abs)
  return raw as RagChunkerConfig
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merges configs left to right. `undefined` never overwrites; arrays are replaced. */
export function mergeConfigs(...configs: Array<RagChunkerConfig | undefined>): RagChunkerConfig {
  const out: Record<string, unknown> = {}
  for (const cfg of configs) {
    if (cfg) mergeInto(out, cfg as Record<string, unknown>)
  }
  return out as RagChunkerConfig
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const existing = target[key]
    if (isPlainObject(value) && isPlainObject(existing)) {
      const copy = { ...existing }
      mergeInto(copy, value)
      target[key] = copy
    } else if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {}
      mergeInto(copy, value)
      target[key] = copy
    } else {
      target[key] = value
    }
  }
}

function parseConfig(input: unknown, source?: string): ResolvedConfig {
  const result = configSchema.safeParse(input ?? {})
  if (!result.success) {
    const where = source ? ` in ${source}` : ''
    throw new RagChunkerError(
      'CONFIG_INVALID',
      `Invalid configuration${where}:\n${z.prettifyError(result.error)}`,
    )
  }
  return result.data
}

/** Applies defaults and validates. Throws RagChunkerError('CONFIG_INVALID') with a readable message. */
export function resolveConfig(input: RagChunkerConfig | undefined): ResolvedConfig {
  return parseConfig(input)
}

export interface LoadConfigOptions {
  cwd?: string
  /** Explicit config file. When omitted, rag-chunker.config.{json,mjs,js} is searched in cwd. */
  configPath?: string
  /** Set to false to skip searching for a config file. */
  searchConfigFile?: boolean
  /** Highest-priority values (for example CLI flags). */
  overrides?: RagChunkerConfig
}

export interface LoadedConfig {
  config: ResolvedConfig
  file: string | undefined
}

/** Resolution order: overrides (CLI flags) > config file > defaults. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd()
  const file = options.configPath
    ? resolve(cwd, options.configPath)
    : options.searchConfigFile === false
      ? undefined
      : findConfigFile(cwd)
  const fromFile = file ? await loadConfigFile(file) : undefined
  return { config: resolveConfig(mergeConfigs(fromFile, options.overrides)), file }
}

/** Reads KEY=VALUE lines from a .env file into an object (does not touch process.env). */
export async function readDotEnv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {}
  const text = await readFile(path, 'utf8')
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    let value = m[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    out[m[1] as string] = value
  }
  return out
}
