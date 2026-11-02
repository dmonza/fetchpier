/**
 * REQ-0073 §5.2 — reference computation: which known workspaces reference each
 * keyId, with an honest "could not check" when a workspace is unreadable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { secrets, workspace } from '@fetchpier/core'
import { computeReferences } from './references'

const made: string[] = []

async function makeWorkspaceWithKey(): Promise<{ path: string; keyId: string }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'fp-ref-ws-'))
  made.push(path)
  await fs.mkdir(join(path, '.fetchpier'), { recursive: true })
  const key = await secrets.generateWorkspaceKey()
  const manifest = await secrets.buildManifest(key)
  await workspace.openWorkspace(path).secrets.writeManifest(manifest)
  return { path, keyId: manifest.encryption.keyId }
}

async function makeWorkspaceWithoutSecrets(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'fp-ref-plain-'))
  made.push(path)
  await fs.mkdir(join(path, '.fetchpier'), { recursive: true })
  return path
}

beforeEach(() => {
  made.length = 0
})
afterEach(async () => {
  await Promise.all(made.map((p) => fs.rm(p, { recursive: true, force: true })))
})

describe('computeReferences', () => {
  it('maps each known workspace to the keyId its manifest references', async () => {
    const a = await makeWorkspaceWithKey()
    const b = await makeWorkspaceWithKey()
    const refs = await computeReferences([a.path, b.path])
    expect(refs.incomplete).toBe(false)
    expect(refs.byKeyId[a.keyId]).toEqual([basename(a.path)])
    expect(refs.byKeyId[b.keyId]).toEqual([basename(b.path)])
  })

  it('lists every workspace that shares the same keyId', async () => {
    const a = await makeWorkspaceWithKey()
    // Clone: copy the manifest into a second workspace folder (same keyId).
    const clone = await fs.mkdtemp(join(tmpdir(), 'fp-ref-clone-'))
    made.push(clone)
    await fs.mkdir(join(clone, '.fetchpier'), { recursive: true })
    await fs.copyFile(
      join(a.path, '.fetchpier', 'secrets.json'),
      join(clone, '.fetchpier', 'secrets.json')
    )
    const refs = await computeReferences([a.path, clone])
    expect(refs.byKeyId[a.keyId]).toEqual([basename(a.path), basename(clone)])
  })

  it('does not flag a workspace that simply has no secrets manifest', async () => {
    const plain = await makeWorkspaceWithoutSecrets()
    const refs = await computeReferences([plain])
    expect(refs.byKeyId).toEqual({})
    expect(refs.incomplete).toBe(false)
  })

  it('reports "could not check" when a known workspace folder is missing', async () => {
    const a = await makeWorkspaceWithKey()
    const missing = join(tmpdir(), 'fp-ref-deleted-does-not-exist-xyz')
    const refs = await computeReferences([a.path, missing])
    expect(refs.byKeyId[a.keyId]).toEqual([basename(a.path)])
    expect(refs.incomplete).toBe(true)
  })
})
