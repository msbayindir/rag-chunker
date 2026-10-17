import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['test/setup/global.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/inspect/assets.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
})
