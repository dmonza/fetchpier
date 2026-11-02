/**
 * The floor is stated in three places that cannot import each other: the
 * package manifest (`engines.node`, read by npm), a source constant (the
 * published tarball ships only `dist/`, so a manifest read at runtime is not
 * dependable), and the CI matrix. These tests are the drift guard between the
 * first two — the third is a comment in `ci.yml` pointing back here.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_FLOOR, unsupportedNodeMessage } from './node-floor'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')

describe('NODE_FLOOR', () => {
  it('matches the `engines.node` range the package publishes', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
      engines?: { node?: string }
    }

    expect(pkg.engines?.node).toBe(`>=${NODE_FLOOR}`)
  })
})

describe('the binary entry point', () => {
  it('imports the floor check before anything else', () => {
    // The check only works because its module body runs before the bundle's
    // module-scope `require("undici")`. That is a property of the import order
    // in `fp.ts`, and nothing about reordering imports looks dangerous — hence
    // this guard. Verified end-to-end against a built `dist/fp.js` run with a
    // faked `process.versions.node` (PLAN-0171 §5 manual checks).
    const source = readFileSync(join(PACKAGE_ROOT, 'src/fp.ts'), 'utf-8')
    const firstImport = /^import .*$/m.exec(source)

    expect(firstImport?.[0]).toBe("import './node-floor'")
  })
})

describe('unsupportedNodeMessage', () => {
  // No "patch below the floor" case: the floor's patch is 0, so no such
  // version exists. If the floor ever moves to a non-zero patch, add one.
  it.each([
    ['a lower major', '20.19.0'],
    ['a much lower major', '18.20.8'],
    ['the same major, a lower minor', '22.18.0'],
    ['the same major, one minor below', '22.18.99']
  ])('rejects %s', (_label, version) => {
    expect(unsupportedNodeMessage(version)).not.toBe('')
  })

  it.each([
    ['the floor exactly', NODE_FLOOR],
    ['a higher patch', '22.19.4'],
    ['a higher minor', '22.20.0'],
    ['a higher major', '24.18.0'],
    ['a far-future major', '30.0.0']
  ])('accepts %s', (_label, version) => {
    expect(unsupportedNodeMessage(version)).toBe('')
  })

  it.each([
    ['a supported major', '25.0.0-nightly20260101', ''],
    ['an unsupported major', '20.0.0-nightly20260101', 'rejected']
  ])('handles a prerelease of %s by its numeric core', (_label, version, expected) => {
    // `process.versions.node` on a nightly reads like `25.0.0-nightly2026…`.
    const message = unsupportedNodeMessage(version)
    expect(message === '' ? '' : 'rejected').toBe(expected)
  })

  it('names the required version, the actual one, and the binary', () => {
    const message = unsupportedNodeMessage('20.19.0')

    expect(message).toContain(NODE_FLOOR)
    expect(message).toContain('20.19.0')
    expect(message).toContain('fp')
  })

  it.each([
    ['an unparseable string', 'not-a-version'],
    ['an empty string', ''],
    ['a partial version', '22']
  ])('lets %s through rather than blocking on a guess', (_label, version) => {
    // Better to reach a real error downstream than to refuse to start over a
    // version string this code failed to understand.
    expect(unsupportedNodeMessage(version)).toBe('')
  })
})
