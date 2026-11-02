import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Guards the single-source-of-truth invariant for the pinned HTTP test target
// (CI-002).
//
// The harness provisions the container itself, so nothing else needs the image
// reference. If a second copy of the digest appeared in a workflow or a script,
// the two could diverge and a run could quietly use a different build than the
// repository declares — which is the whole failure mode the pin exists to
// prevent. Prose in docs is not checked: documentation going stale is a
// different (and non-executable) problem.

const REPO_ROOT = process.cwd()
const DESCRIPTOR_PATH = resolve(REPO_ROOT, 'test', 'httpbin-image.json')

/** Places where a duplicated digest would actually change what a run executes. */
const EXECUTABLE_ROOTS = ['.github', 'scripts']
const EXECUTABLE_FILES = ['package.json', 'playwright.config.ts', 'vitest.config.ts']

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const descriptor = JSON.parse(readFileSync(DESCRIPTOR_PATH, 'utf-8')) as {
  image: string
  digest: string
  hostPort: number
  containerPort: number
  containerName: string
}

describe('pinned HTTP target descriptor', () => {
  it('declares every field the harness needs', () => {
    expect(typeof descriptor.image).toBe('string')
    expect(typeof descriptor.digest).toBe('string')
    expect(typeof descriptor.hostPort).toBe('number')
    expect(typeof descriptor.containerPort).toBe('number')
    expect(typeof descriptor.containerName).toBe('string')
  })

  it('pins an immutable digest rather than a mutable tag', () => {
    expect(descriptor.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('states the digest in exactly one committed location', () => {
    const candidates = [
      ...EXECUTABLE_ROOTS.flatMap((r) => walk(resolve(REPO_ROOT, r))),
      ...EXECUTABLE_FILES.map((f) => resolve(REPO_ROOT, f)).filter((f) => existsSync(f))
    ]

    const offenders = candidates.filter((file) => {
      try {
        return readFileSync(file, 'utf-8').includes(descriptor.digest)
      } catch {
        // Binary or unreadable file — cannot restate a digest meaningfully.
        return false
      }
    })

    expect(offenders.map((f) => f.replace(REPO_ROOT, '').replace(/\\/g, '/'))).toEqual([])
  })
})
