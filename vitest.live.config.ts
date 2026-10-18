import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    globalSetup: ['test/setup/global.ts'],
    fileParallelism: false,
  },
})
