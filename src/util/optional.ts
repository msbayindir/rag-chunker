import { RagChunkerError } from '../errors.js'

/**
 * Imports an optional dependency, turning "module not found" into an actionable error.
 * `loader` must be a literal `() => import('pkg')` so bundlers and TypeScript can see it.
 */
export async function importOptional<T>(pkg: string, purpose: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new RagChunkerError('OPTIONAL_DEPENDENCY_MISSING', `${purpose} needs the "${pkg}" package`, {
        hint: `Install it with: npm install ${pkg}`,
        cause: err,
      })
    }
    throw err
  }
}
