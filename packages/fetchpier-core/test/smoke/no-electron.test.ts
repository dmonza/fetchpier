import { describe, it, expect } from 'vitest'
import { execSync, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// packages/fetchpier-core/test/smoke → package root is two levels up.
const PACKAGE_ROOT = resolve(here, '../..')
const REPO_ROOT = resolve(here, '../../../..')
const DIST = resolve(PACKAGE_ROOT, 'dist/index.js')
const DIST_SCHEMA = resolve(PACKAGE_ROOT, 'dist/schema-import.js')

describe('@fetchpier/core boundary', () => {
  it('loads from plain Node without pulling in Electron', () => {
    // The runtime invariant for the future CLI: requiring the bundled package
    // in a fresh Node process must not load any Electron module. We inspect the
    // child's require.cache rather than this process's, which other tests may
    // already have polluted.
    if (!existsSync(DIST) || !existsSync(DIST_SCHEMA)) {
      // Self-heal so `npm run test` works on a fresh clone without a prior
      // `npm run build:core`.
      execSync('npm run build:core', { cwd: REPO_ROOT, stdio: 'inherit' })
    }

    const script = `require(${JSON.stringify(DIST)}); console.log(JSON.stringify(Object.keys(require.cache)))`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    const cached = JSON.parse(out) as string[]

    const offenders = cached.filter(
      (p) => /[\\/]electron[\\/]/.test(p) || /@electron-toolkit/.test(p)
    )
    expect(offenders).toEqual([])
  }, 60000)

  it('exposes the expected cold-path namespaces (schemaImport intentionally absent)', () => {
    // REQ-0063 split schemaImport into the `@fetchpier/core/schema-import`
    // secondary entry. The main barrel must NOT expose it — that's what keeps
    // graphql/js-yaml and the importers off the main-process cold path.
    const script = `const c = require(${JSON.stringify(DIST)}); console.log(JSON.stringify(Object.keys(c)))`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    const keys = JSON.parse(out) as string[]
    expect(keys).toEqual(
      expect.arrayContaining(['CoreError', 'workspace', 'scripting', 'requests', 'tls'])
    )
    expect(keys).not.toContain('schemaImport')
  }, 60000)

  it('loads the schema-import entry from plain Node without pulling in Electron', () => {
    const script = `const c = require(${JSON.stringify(DIST_SCHEMA)}); const cached = Object.keys(require.cache); console.log(JSON.stringify({ exports: Object.keys(c), cached }))`
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
    const result = JSON.parse(out) as { exports: string[]; cached: string[] }

    const offenders = result.cached.filter(
      (p) => /[\\/]electron[\\/]/.test(p) || /@electron-toolkit/.test(p)
    )
    expect(offenders).toEqual([])
    expect(result.exports).toEqual(expect.arrayContaining(['detectFormat', 'importSchema']))
  }, 60000)
})
