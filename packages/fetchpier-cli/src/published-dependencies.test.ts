/**
 * What the published tarball must install for itself.
 *
 * `@fetchpier/core` is bundled into this package (`noExternal`), so core's own
 * `dependencies` are never installed for a consumer of `@fetchpier/cli`.
 * Everything esbuild can follow ends up inlined and that is fine; what does not
 * is the handful of specifiers core resolves through `createRequire` at run
 * time. Those survive in `dist/fp.js` as resolutions against the installed
 * package, so this package has to declare them like any ordinary dependency.
 *
 * The obligation is invisible from either manifest on its own, which is how
 * `libsodium-wrappers` was missing from a shipped tarball: `fp` resolved it fine
 * in the monorepo, where the root install hoists it. The failure needed a global
 * install to appear, and surfaced as "invalid workspace key" rather than as a
 * missing module — see `runtime-dynamic-deps.ts` for that path.
 *
 * Same genre as `node-floor.test.ts`: two committed facts that cannot import
 * each other, pinned to one another by a test.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DYNAMIC_RUNTIME_DEPENDENCIES } from '@fetchpier/core/runtime-dynamic-deps'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function manifest(packageRoot: string): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as Manifest
}

const cli = manifest(PACKAGE_ROOT)
const core = manifest(resolve(PACKAGE_ROOT, '../fetchpier-core'))

const dynamic: [string][] = DYNAMIC_RUNTIME_DEPENDENCIES.map((name) => [name])

describe('the published dependency set', () => {
  it.each(dynamic)(
    'declares %s, which core resolves at run time and no bundler can inline',
    (name) => {
      expect(Object.keys(cli.dependencies ?? {})).toContain(name)
    }
  )

  // A `devDependency` is absent from an installed tarball, so satisfying the
  // rule there would be indistinguishable from not satisfying it at all.
  it.each(dynamic)('declares %s as a runtime dependency, not a dev one', (name) => {
    expect(Object.keys(cli.devDependencies ?? {})).not.toContain(name)
  })

  it.each(dynamic)(
    'asks for %s on the same terms core does, so one install satisfies both',
    (name) => {
      expect(cli.dependencies?.[name]).toBe(core.dependencies?.[name])
    }
  )
})
