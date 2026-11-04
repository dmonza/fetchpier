// CLI-097 — the published tarball carries the license notices of every
// third-party package bundled into dist/, and only those.
import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = join(PACKAGE_ROOT, 'dist')
const NOTICES = join(DIST, 'THIRD_PARTY_LICENSES.txt')

/** Packages installed by npm next to the CLI — never bundled, never listed. */
const EXTERNAL = ['undici', 'mime', 'fast-xml-parser', 'libsodium-wrappers']

/**
 * The oracle, deliberately independent of the generator: every package whose
 * files appear in the built sourcemaps, as `name@version` read from its manifest.
 */
function bundledPackagesFromSourcemaps(): string[] {
  const found = new Set<string>()
  for (const file of readdirSync(DIST).filter((f) => f.endsWith('.map'))) {
    const map = JSON.parse(readFileSync(join(DIST, file), 'utf-8')) as { sources: string[] }
    for (const source of map.sources) {
      const abs = resolve(DIST, source).split('\\').join('/')
      const match = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(abs)
      if (!match) continue
      const root =
        abs.slice(0, abs.lastIndexOf(`/node_modules/${match[1]}/`)) + `/node_modules/${match[1]}`
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
      found.add(`${manifest.name}@${manifest.version}`)
    }
  }
  return [...found].sort()
}

beforeAll(() => {
  if (!existsSync(join(DIST, 'fp.js'))) {
    throw new Error(`[cli] CLI bundle missing: ${DIST}. Run the suite via npm test / test:cli.`)
  }
})

describe('published tarball license notices (CLI-097)', () => {
  it('names every bundled package with its license text, and no external one', () => {
    expect(existsSync(NOTICES)).toBe(true)
    const text = readFileSync(NOTICES, 'utf-8')

    const bundled = bundledPackagesFromSourcemaps()
    expect(bundled.length).toBeGreaterThan(0)
    for (const id of bundled) expect(text, id).toContain(`${id} (`)
    expect(text).toMatch(/Copyright/)

    for (const name of EXTERNAL) expect(text).not.toMatch(new RegExp(`^${name}@`, 'm'))
  })

  it('is part of the packed file list', () => {
    // `--ignore-scripts`: `prepack` would rebuild dist/ while other specs run it.
    // Fixed literal command through a shell (npm is a .cmd shim on Windows).
    const r = spawnSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: PACKAGE_ROOT,
      shell: true,
      encoding: 'utf-8'
    })
    expect(r.status, r.stderr).toBe(0)
    const [report] = JSON.parse(r.stdout) as [{ files: { path: string }[] }]
    expect(report.files.map((f) => f.path)).toContain('dist/THIRD_PARTY_LICENSES.txt')
  }, 60000)
})
