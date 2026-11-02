import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['scripts/perf/**/*.bench.ts'],
    environment: 'node'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../src/shared')
    }
  }
})
