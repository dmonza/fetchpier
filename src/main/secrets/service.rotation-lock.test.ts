/**
 * SEC-03 (review) — key rotation is a `localvalues.json` read-modify-write too:
 * a script write landing between the rotation's re-read and its rename batch
 * must not be overwritten by the rotation's stale snapshot. The core batch is
 * wrapped so the write lands exactly in that window. Electron is mocked; the
 * filesystem is a real temp workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^sealed:/, '')
  },
  systemPreferences: {
    canPromptTouchID: () => false,
    promptTouchID: async () => undefined
  }
}))

const batchHook = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }))

vi.mock('@fetchpier/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@fetchpier/core')>()
  return {
    ...core,
    workspace: {
      ...core.workspace,
      atomicWriteBatch: async (writes: Parameters<typeof core.workspace.atomicWriteBatch>[0]) => {
        if (batchHook.before) await batchHook.before()
        return core.workspace.atomicWriteBatch(writes)
      }
    }
  }
})

import * as service from './service'
import * as localValues from './local-values'
import { lockAll } from './unlock-state'
import { secrets, workspace } from '@fetchpier/core'

let ws: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-rot-lock-ud-'))
  ws = await fs.mkdtemp(join(tmpdir(), 'fp-rot-lock-'))
  await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
  await fs.writeFile(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  await fs.mkdir(join(ws, 'environments', 'dev'), { recursive: true })
  await fs.writeFile(
    join(ws, 'environments', 'dev', 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables: { apiToken: 'PLAIN' } })
  )
  lockAll()
  batchHook.before = null
})
afterEach(async () => {
  batchHook.before = null
  lockAll()
  await fs.rm(userDataDir, { recursive: true, force: true })
  await fs.rm(ws, { recursive: true, force: true })
})

describe('key rotation and concurrent local-values writers (SEC-03)', () => {
  it('a script write landing while the rotation renames its batch is kept', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'shared-secret')
    // A secret-named local override: the rotation re-wraps this file.
    await localValues.setLocalValue(ws, 'dev', 'apiToken', 'my-local')

    let pending: Promise<unknown> | undefined
    batchHook.before = async () => {
      batchHook.before = null
      pending = localValues.persistScriptEnvChanges(ws, 'dev', {
        set: { fromScript: 'y' },
        removed: []
      })
      // Give the write every chance to land before the batch renames.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const { keyId } = await service.rotateKey(ws)
    await pending

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.fromScript).toBe('y')
    expect(lv.keyId).toBe(keyId)
    expect(secrets.isEncryptedValue(lv.variables.apiToken)).toBe(true)
    expect((await workspace.openWorkspace(ws).secrets.readManifest())?.encryption.keyId).toBe(keyId)
  })
})
