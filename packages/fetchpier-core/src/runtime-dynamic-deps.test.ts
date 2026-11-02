/**
 * Core reaches a few packages through `createRequire(...)(specifier)` rather
 * than a static import. esbuild cannot follow that call, so those specifiers
 * survive verbatim into every bundle that inlines core — and a consumer that
 * bundles core instead of depending on it must install them itself.
 *
 * `DYNAMIC_RUNTIME_DEPENDENCIES` is the list consumers are entitled to trust.
 * These tests are the drift guard between the list and the call sites: adding a
 * lazy `createRequire` load without listing it turns this red, which is the only
 * moment anyone is looking at the question. The other half of the guard —
 * that each listed specifier is declared by the CLI that bundles core — lives in
 * `packages/fetchpier-cli/src/published-dependencies.test.ts`, because it is a
 * fact about that package's manifest, not about this one.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DYNAMIC_RUNTIME_DEPENDENCIES } from './runtime-dynamic-deps'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const SRC = join(PACKAGE_ROOT, 'src')

/** Every `.ts` file under `src/`, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    out.push(full)
  }
  return out
}

/**
 * The specifiers reached through a require built by `createRequire`.
 *
 * Matched off the binding the call produces rather than the literal text
 * `createRequire(...)(...)`: the anchor is computed on its own line, so the two
 * halves are never adjacent in the source.
 */
function dynamicSpecifiersIn(source: string): string[] {
  const binding = /const\s+(\w+)\s*=\s*createRequire\(/.exec(source)
  if (!binding) return []

  const calls = new RegExp(`\\b${binding[1]}\\(\\s*['"]([^'"]+)['"]`, 'g')
  return [...source.matchAll(calls)].map((match) => match[1])
}

describe('DYNAMIC_RUNTIME_DEPENDENCIES', () => {
  it('accounts for every specifier core resolves through createRequire', () => {
    const found = new Set<string>()
    for (const file of sourceFiles(SRC)) {
      for (const specifier of dynamicSpecifiersIn(readFileSync(file, 'utf-8'))) {
        found.add(specifier)
      }
    }

    expect([...found].sort()).toEqual([...DYNAMIC_RUNTIME_DEPENDENCIES].sort())
  })

  // Without this the suite would pass on an empty list against a codebase that
  // had quietly stopped using createRequire — and the CLI-side guard, which
  // iterates this list, would pass vacuously along with it.
  it('is not empty', () => {
    expect(DYNAMIC_RUNTIME_DEPENDENCIES.length).toBeGreaterThan(0)
  })

  it('lists only packages this package actually depends on', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
    }

    for (const specifier of DYNAMIC_RUNTIME_DEPENDENCIES) {
      expect(Object.keys(pkg.dependencies ?? {})).toContain(specifier)
    }
  })
})

describe('the specifier extractor', () => {
  // The guard above is only as good as what this finds. These pin the two
  // shapes that matter: the real one, and a static import that must not be
  // mistaken for a dynamic load.
  it('finds a specifier loaded through a createRequire binding', () => {
    const source = [
      'const requireFrom = createRequire(anchor)',
      "const sodium = requireFrom('libsodium-wrappers')"
    ].join('\n')

    expect(dynamicSpecifiersIn(source)).toEqual(['libsodium-wrappers'])
  })

  it('ignores a file with no createRequire at all', () => {
    expect(dynamicSpecifiersIn("import { x } from 'undici'\nconst y = require('mime')")).toEqual([])
  })
})
