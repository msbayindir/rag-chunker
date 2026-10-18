// Packs the library, installs the tarball in a clean folder and runs the CLI + API from it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const fixture = join(root, 'test', 'fixtures', 'generated', 'turkish.pdf')
if (!existsSync(fixture)) {
  console.log('Generating fixtures…')
  run(npx, ['vitest', 'run', 'test/unit/documents.test.ts'], root)
}

const work = mkdtempSync(join(tmpdir(), 'rag-chunker-pack-'))
try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', work], root))[0]
  const tarball = join(work, packed.filename)
  const unexpected = packed.files
    .map((f) => f.path)
    .filter((p) => !/^(dist\/|schema\/|README|LICENSE|CHANGELOG|package\.json)/.test(p))
  if (unexpected.length) throw new Error(`Unexpected files in the package: ${unexpected.join(', ')}`)
  console.log(
    `packed ${packed.filename} (${packed.files.length} files, ${(packed.size / 1024).toFixed(0)} kB)`,
  )

  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'smoke', version: '1.0.0', type: 'module' }),
  )
  run(npm, ['install', '--no-audit', '--no-fund', tarball], work)

  const version = run(npx, ['rag-chunker', '--version'], work).trim()
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (version !== expected) throw new Error(`CLI version ${version} != ${expected}`)

  run(npx, ['rag-chunker', 'process', fixture, '-o', 'out', '--no-cache'], work)
  const manifest = JSON.parse(readFileSync(join(work, 'out', 'manifest.json'), 'utf8'))
  if (manifest.stages.chunk.count < 1) throw new Error('No chunks produced')

  JSON.parse(run(npx, ['rag-chunker', 'doctor', '--json'], work))

  writeFileSync(
    join(work, 'api.mjs'),
    `import { chunkMarkdown, processDocument, resolveConfig } from '@msbayindir/rag-chunker'
const chunks = chunkMarkdown('# Başlık\\n\\nMerhaba dünya, bu bir deneme metnidir.', { minTokens: 0 })
if (chunks.length !== 1) throw new Error('chunkMarkdown failed')
resolveConfig({})
const res = await processDocument(${JSON.stringify(fixture)}, { cache: { enabled: false } }, { env: {} })
if (res.chunks.length < 1) throw new Error('processDocument failed')
console.log('api ok')`,
  )
  run('node', ['api.mjs'], work)
  if (!existsSync(join(work, 'node_modules', '@msbayindir', 'rag-chunker', 'schema', 'config.schema.json'))) {
    throw new Error('schema/config.schema.json missing from the package')
  }
  console.log(`pack smoke test passed (v${version})`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
