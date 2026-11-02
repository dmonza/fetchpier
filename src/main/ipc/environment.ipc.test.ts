import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import type { Environment } from '../../shared/types'
import { workspace } from '@fetchpier/core'

// ── Capture ipcMain.handle registrations ────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  }
}))

// Active workspace points at a per-test temp directory. The handlers now resolve
// the workspace handle; the mock returns a real handle over the temp dir, so the
// env:save merge exercises the handle's `environments.save`.
const ws = { path: '' as string }
vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => {
    if (!ws.path) throw new Error('No active workspace')
    return workspace.openWorkspace(ws.path)
  }
}))

import { registerEnvironmentHandlers } from './environment.ipc'

registerEnvironmentHandlers()

const ENC = 'enc:v1:abc' // a value isEncryptedValue() accepts

async function seed(env: Environment): Promise<void> {
  await workspace.openWorkspace(ws.path).environments.write(env)
}

async function readVariables(id: string): Promise<Record<string, string | null>> {
  const raw = await fs.readFile(
    workspace.openWorkspace(ws.path).environments.configPath(id),
    'utf-8'
  )
  return (JSON.parse(raw) as Environment).variables
}

async function save(env: Environment): Promise<void> {
  await handlers.get('env:save')!(null, env)
}

async function saveWithBaseline(
  env: Environment,
  baseline: Record<string, string | null>
): Promise<void> {
  await handlers.get('env:save')!(null, env, baseline)
}

describe('env:save — key order (REQ-0079)', () => {
  beforeEach(async () => {
    ws.path = await mkdtemp(join(tmpdir(), 'fp-env-ipc-'))
  })

  afterEach(async () => {
    await rm(ws.path, { recursive: true, force: true })
  })

  it('persists the variables in the order the renderer sends, interleaving secrets', async () => {
    // On disk, secret is authored first; the renderer reorders to b, a, sec.
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { sec: ENC, a: '1', b: '2' } })

    await save({ id: 'dev', folder: 'dev', name: 'dev', variables: { b: '2', sec: ENC, a: '1' } })

    const vars = await readVariables('dev')
    expect(Object.keys(vars)).toEqual(['b', 'sec', 'a'])
    // The secret value is the disk value, carried verbatim.
    expect(vars.sec).toBe(ENC)
  })

  it('sources the secret value from disk, ignoring the renderer payload value', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { sec: ENC } })

    // Renderer sends a different (stale) ciphertext at the same position.
    await save({ id: 'dev', folder: 'dev', name: 'dev', variables: { sec: 'enc:v1:STALE' } })

    const vars = await readVariables('dev')
    expect(vars.sec).toBe(ENC)
  })

  it('appends disk secrets the renderer omitted, so secret material is never dropped', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { sec: ENC, a: '1' } })

    // Renderer payload omits the secret entirely (e.g. a stale view).
    await save({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1' } })

    const vars = await readVariables('dev')
    expect(Object.keys(vars)).toEqual(['a', 'sec'])
    expect(vars.sec).toBe(ENC)
  })

  it('rejects a plain value claiming the reserved enc: prefix for a non-secret name', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1' } })

    await expect(
      save({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1', fake: 'enc:v1:forged' } })
    ).rejects.toThrow(/reserved for encrypted secrets/)
  })

  it('rejects a variable name beginning with the reserved `$` prefix (REQ-0087 / CA-06)', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1' } })

    await expect(
      save({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1', $myVar: 'v' } })
    ).rejects.toThrow(/reserved for system dynamic variables/)

    // Nothing was persisted: the prior on-disk state is intact.
    const vars = await readVariables('dev')
    expect(vars).toEqual({ a: '1' })
  })

  it('keeps a needs-value secret (null) at its renderer position', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1', sec: null } })

    await save({ id: 'dev', folder: 'dev', name: 'dev', variables: { sec: null, a: '1' } })

    const vars = await readVariables('dev')
    expect(Object.keys(vars)).toEqual(['sec', 'a'])
    expect(vars.sec).toBeNull()
  })
})

describe('env:save — concurrent plain-variable merge (CA-07)', () => {
  beforeEach(async () => {
    ws.path = await mkdtemp(join(tmpdir(), 'fp-env-merge-'))
  })
  afterEach(async () => {
    await rm(ws.path, { recursive: true, force: true })
  })

  it('preserves a concurrent edit to a different variable (different-var, both survive)', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', B: '1' } })

    // Editor 1 (fresh snapshot) changes A and saves.
    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '2', B: '1' } },
      { A: '1', B: '1' }
    )
    // Editor 2 (stale snapshot from before editor 1) changes B and saves.
    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', B: '2' } },
      { A: '1', B: '1' }
    )

    expect(await readVariables('dev')).toEqual({ A: '2', B: '2' })
  })

  it('same-variable edit stays last-writer-wins', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1' } })
    // Disk already moved to A:'2' (other editor). Stale saver changes A to '9'.
    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '2' } },
      { A: '1' }
    )
    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '9' } },
      { A: '1' }
    )

    expect(await readVariables('dev')).toEqual({ A: '9' })
  })

  it('honors a deletion: a variable in the baseline but absent from the payload is removed', async () => {
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', B: '1' } })

    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1' } },
      { A: '1', B: '1' }
    )

    expect(await readVariables('dev')).toEqual({ A: '1' })
  })

  it('preserves a variable added concurrently elsewhere (not in baseline, not in payload)', async () => {
    // Disk has C that the saver never knew about (added by another editor).
    await seed({ id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', C: 'fromElsewhere' } })

    await saveWithBaseline(
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '2' } },
      { A: '1' }
    )

    expect(await readVariables('dev')).toEqual({ A: '2', C: 'fromElsewhere' })
  })
})
