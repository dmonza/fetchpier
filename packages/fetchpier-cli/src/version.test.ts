import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_VERSION } from './version'

describe('CLI_VERSION', () => {
  it('matches package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
      version: string
    }
    expect(CLI_VERSION).toBe(pkg.version)
  })
})
