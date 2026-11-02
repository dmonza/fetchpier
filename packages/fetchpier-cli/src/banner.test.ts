/**
 * The banner's copyright line is a source constant because the published
 * package only ships `dist/` — a runtime read of LICENSE is not dependable
 * across install shapes. These tests are the drift guard that keeps the
 * constant equal to what the LICENSE files actually say, and make sure the
 * license travels with the package (MIT requires the notice to ship).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COPYRIGHT_LINE, formatBanner } from './banner'
import { CLI_VERSION } from './version'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const REPO_ROOT = resolve(here, '../../..')

function copyrightLineOf(path: string): string | undefined {
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('Copyright'))
}

describe('COPYRIGHT_LINE', () => {
  it.each([
    ['the repository LICENSE', join(REPO_ROOT, 'LICENSE')],
    ['the packaged CLI LICENSE', join(PACKAGE_ROOT, 'LICENSE')]
  ])('matches %s verbatim', (_label, path) => {
    expect(copyrightLineOf(path)).toBe(COPYRIGHT_LINE)
  })
})

describe('package manifest', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
    files: string[]
  }

  it('publishes the LICENSE file', () => {
    expect(pkg.files).toContain('LICENSE')
  })
})

describe('formatBanner', () => {
  it('prints the product name and version on the first line', () => {
    expect(formatBanner().split('\n')[0]).toBe(`Fetchpier ${CLI_VERSION}`)
  })

  it('prints the copyright line beneath it', () => {
    expect(formatBanner().split('\n')[1]).toBe(COPYRIGHT_LINE)
  })

  it('is exactly two lines', () => {
    expect(formatBanner().split('\n')).toHaveLength(2)
  })
})
