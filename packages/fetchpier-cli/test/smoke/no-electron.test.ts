import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// packages/fetchpier-cli/test/smoke → package root is two levels up.
const PACKAGE_ROOT = resolve(here, '../..')
const DIST = resolve(PACKAGE_ROOT, 'dist/index.js')

describe('@fetchpier/cli boundary', () => {
  it('loads from plain Node without pulling in Electron', () => {
    // Defense in depth alongside the eslint boundary: requiring the bundled CLI
    // in a fresh Node process must not load any Electron module. We inspect the
    // child's require.cache, not this process's (other tests may have polluted
    // it). The CLI ships CJS so `require` works directly.
    // Built by the `cli` project's globalSetup, not here: a per-spec build
    // races the other specs' builds and blows the 10 s hook budget.
    if (!existsSync(DIST)) {
      throw new Error(
        `[cli] CLI bundle missing: ${DIST}\n` +
          `Run the suite via \`npm test\` / \`npm run test:cli\` so globalSetup builds it.`
      )
    }

    const script = `require(${JSON.stringify(DIST)}); console.log(JSON.stringify(Object.keys(require.cache)))`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    const cached = JSON.parse(out) as string[]

    const offenders = cached.filter(
      (p) => /[\\/]electron[\\/]/.test(p) || /@electron-toolkit/.test(p)
    )
    expect(offenders).toEqual([])
  }, 120000)

  it('exposes the programmatic API', () => {
    const script = `const c = require(${JSON.stringify(DIST)}); console.log(JSON.stringify(Object.keys(c)))`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    const keys = JSON.parse(out) as string[]
    expect(keys).toEqual(expect.arrayContaining(['run', 'CLI_VERSION', 'EXIT', 'CliError']))
  }, 120000)
})
