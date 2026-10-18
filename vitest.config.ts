import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['test/setup/global.ts'],
    // Unit tests never see models a developer downloaded, so "auto" layout and OCR stay off.
    env: { RAG_CHUNKER_MODELS_DIR: join(tmpdir(), 'rag-chunker-unit-tests', 'models') },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/inspect/assets.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
})
