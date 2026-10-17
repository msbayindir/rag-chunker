import { join } from 'node:path'
import { readDotEnv } from '../config/load.js'

/** Environment for CLI runs: values from ./.env, overridden by the real environment. */
export async function cliEnv(cwd = process.cwd()): Promise<Record<string, string | undefined>> {
  const dotenv = await readDotEnv(join(cwd, '.env'))
  return { ...dotenv, ...process.env }
}
