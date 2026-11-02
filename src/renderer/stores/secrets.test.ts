import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSecretsStore } from './secrets'
import type { Environment, SecretsStatus } from '../../shared/types'

interface SecretsApiMock {
  status: ReturnType<typeof vi.fn>
  setup: ReturnType<typeof vi.fn>
  enterKey: ReturnType<typeof vi.fn>
  reveal: ReturnType<typeof vi.fn>
  setSecret: ReturnType<typeof vi.fn>
  unsetSecret: ReturnType<typeof vi.fn>
  clearSecret: ReturnType<typeof vi.fn>
  deleteSecret: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  listKeys: ReturnType<typeof vi.fn>
  deleteKey: ReturnType<typeof vi.fn>
  addKey: ReturnType<typeof vi.fn>
}

const LISTING = {
  entries: [
    {
      keyId: 'abc1230000000000',
      workspaceHint: 'proyecto-x',
      createdAt: '2026-06-01T00:00:00Z',
      lastUsedAt: '2026-06-04T00:00:00Z',
      backing: 'os-keychain' as const
    }
  ],
  references: { byKeyId: { abc1230000000000: ['proyecto-x'] }, incomplete: false }
}

let api: SecretsApiMock

const LOCKED: SecretsStatus = {
  hasManifest: true,
  unlocked: false,
  backend: 'os-keychain',
  keyId: 'abc123'
}
const UNLOCKED: SecretsStatus = {
  hasManifest: true,
  unlocked: true,
  backend: 'os-keychain',
  keyId: 'abc123'
}

beforeEach(() => {
  api = {
    status: vi.fn().mockResolvedValue(LOCKED),
    setup: vi.fn().mockResolvedValue({ key: 'FPK1-AAA', keyId: 'abc123' }),
    enterKey: vi.fn().mockResolvedValue({ ok: true, keyId: 'abc123' }),
    reveal: vi.fn().mockResolvedValue('plaintext'),
    setSecret: vi.fn(),
    unsetSecret: vi.fn(),
    clearSecret: vi.fn(),
    deleteSecret: vi.fn(),
    rotate: vi.fn().mockResolvedValue({ key: 'FPK1-BBB', keyId: 'def456' }),
    listKeys: vi.fn().mockResolvedValue(LISTING),
    deleteKey: vi.fn().mockResolvedValue(undefined),
    addKey: vi.fn()
  }
  ;(window as unknown as { api: { secrets: SecretsApiMock } }).api = { secrets: api }
  useSecretsStore.setState({ status: null, keys: [], references: null, keysLoading: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('secrets store', () => {
  it('refreshStatus stores and returns the status', async () => {
    const status = await useSecretsStore.getState().refreshStatus()
    expect(status).toEqual(LOCKED)
    expect(useSecretsStore.getState().status).toEqual(LOCKED)
  })

  it('enterKey refreshes status only when unlocked', async () => {
    api.status.mockResolvedValueOnce(UNLOCKED)
    const result = await useSecretsStore.getState().enterKey('FPK1-AAA')
    expect(result.ok).toBe(true)
    expect(api.status).toHaveBeenCalled()
    expect(useSecretsStore.getState().status?.unlocked).toBe(true)
  })

  it('enterKey does not refresh on failure', async () => {
    api.enterKey.mockResolvedValueOnce({ ok: false, reason: 'wrong-key', keyId: 'abc123' })
    api.status.mockClear()
    const result = await useSecretsStore.getState().enterKey('FPK1-WRONG')
    expect(result.ok).toBe(false)
    expect(api.status).not.toHaveBeenCalled()
  })

  it('setup refreshes status after generating the key', async () => {
    api.status.mockResolvedValueOnce(UNLOCKED)
    const result = await useSecretsStore.getState().setup()
    expect(result.key).toBe('FPK1-AAA')
    expect(useSecretsStore.getState().status?.unlocked).toBe(true)
  })

  it('setSecret delegates and returns the updated environment', async () => {
    const updated: Environment = {
      id: 'dev',
      folder: 'dev',
      name: 'dev',
      variables: { t: 'enc:v1:x' }
    }
    api.setSecret.mockResolvedValueOnce(updated)
    const out = await useSecretsStore.getState().setSecret('dev', 't', 'plain')
    expect(api.setSecret).toHaveBeenCalledWith('dev', 't', 'plain')
    expect(out).toEqual(updated)
  })

  it('deleteSecret delegates and returns the updated environment (REQ-0077)', async () => {
    const updated: Environment = {
      id: 'dev',
      folder: 'dev',
      name: 'dev',
      variables: { other: 'x' }
    }
    api.deleteSecret.mockResolvedValueOnce(updated)
    const out = await useSecretsStore.getState().deleteSecret('dev', 'token')
    expect(api.deleteSecret).toHaveBeenCalledWith('dev', 'token')
    expect(out).toEqual(updated)
  })

  it('reveal passes through to the IPC', async () => {
    expect(await useSecretsStore.getState().reveal('dev', 'token')).toBe('plaintext')
    expect(api.reveal).toHaveBeenCalledWith('dev', 'token')
  })

  it('rotate refreshes status after rotation', async () => {
    api.status.mockResolvedValueOnce(UNLOCKED)
    const result = await useSecretsStore.getState().rotate()
    expect(result.keyId).toBe('def456')
    expect(api.status).toHaveBeenCalled()
  })

  // ── REQ-0073 management slice ───────────────────────────────────────────────

  it('listKeys loads entries and references into state', async () => {
    await useSecretsStore.getState().listKeys()
    const state = useSecretsStore.getState()
    expect(state.keys).toEqual(LISTING.entries)
    expect(state.references).toEqual(LISTING.references)
    expect(state.keysLoading).toBe(false)
  })

  it('deleteKey forwards the keyId and refreshes the listing', async () => {
    await useSecretsStore.getState().deleteKey('abc1230000000000')
    expect(api.deleteKey).toHaveBeenCalledWith('abc1230000000000')
    expect(api.listKeys).toHaveBeenCalled()
  })

  it('addKey forwards the pasted key but never retains it in store state', async () => {
    api.addKey.mockResolvedValueOnce({ status: 'added', entry: LISTING.entries[0] })
    const result = await useSecretsStore.getState().addKey('FPK1-SECRET', 'hint')
    expect(result.status).toBe('added')
    expect(api.addKey).toHaveBeenCalledWith('FPK1-SECRET', 'hint', undefined)
    // The pasted key must not be present anywhere in the serialized store state.
    expect(JSON.stringify(useSecretsStore.getState())).not.toContain('FPK1-SECRET')
  })

  it('addKey does not refresh the listing on a conflict result', async () => {
    api.addKey.mockResolvedValueOnce({ status: 'conflict', existing: LISTING.entries[0] })
    api.listKeys.mockClear()
    const result = await useSecretsStore.getState().addKey('FPK1-OTHER')
    expect(result.status).toBe('conflict')
    expect(api.listKeys).not.toHaveBeenCalled()
  })
})
