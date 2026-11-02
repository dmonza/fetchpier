import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock electron primitives ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  dialog: {
    showOpenDialog: vi.fn()
  }
}))

const fsStatMock = vi.fn()
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    promises: { ...actual.promises, stat: (p: string) => fsStatMock(p) }
  }
})

// ── Mocks for the workspace handle's binary façade ───────────────────────────
const stageBinaryMock = vi.fn()
const statBinaryMock = vi.fn()
const removeBinaryMock = vi.fn()
const listBinariesMock = vi.fn()

// ── Mock the settings store ─────────────────────────────────────────────────
let currentLimits: { warnBytes: number; blockBytes: number } | undefined
vi.mock('../config/workspace-settings-store', () => ({
  getCachedHttpSettings: (): { binaryFileLimits?: { warnBytes: number; blockBytes: number } } => ({
    binaryFileLimits: currentLimits
  }),
  loadHttpSettings: async () => ({ binaryFileLimits: currentLimits })
}))

// ── The handlers resolve the active workspace handle from the singleton ───────
vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({
    path: '/ws',
    binary: {
      stage: (...args: unknown[]) => stageBinaryMock(...args),
      stat: (...args: unknown[]) => statBinaryMock(...args),
      remove: (...args: unknown[]) => removeBinaryMock(...args),
      list: (...args: unknown[]) => listBinariesMock(...args)
    }
  })
}))

// Import after the mocks
import { registerBinaryHandlers } from './binary.ipc'
import { dialog } from 'electron'
import { DEFAULT_BINARY_FILE_LIMITS } from '../../shared/types'

const dialogMock = dialog as unknown as { showOpenDialog: ReturnType<typeof vi.fn> }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return (await fn(...args)) as T
}

describe('binary.ipc — selectAndStage limits flow', () => {
  beforeEach(() => {
    handlers.clear()
    registerBinaryHandlers()
    stageBinaryMock.mockReset()
    fsStatMock.mockReset()
    dialogMock.showOpenDialog.mockReset()
    currentLimits = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses GitHub defaults (50 MB warn / 100 MB block) when binaryFileLimits is not set', async () => {
    currentLimits = undefined
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/x.bin'] })
    fsStatMock.mockResolvedValueOnce({ size: 49 * 1024 * 1024 }) // 49 MB
    stageBinaryMock.mockResolvedValueOnce({
      ref: 'a'.repeat(64) + '__x.bin',
      originalName: 'x.bin',
      sizeBytes: 49 * 1024 * 1024,
      mimeType: 'application/octet-stream'
    })
    const res = await invoke<{ status: string }>('binary:selectAndStage', null, {})
    expect(res.status).toBe('staged')
    expect(stageBinaryMock).toHaveBeenCalledTimes(1)
  })

  it('returns requiresConfirmation for 75 MB at default limits', async () => {
    currentLimits = undefined
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/y.bin'] })
    fsStatMock.mockResolvedValueOnce({ size: 75 * 1024 * 1024 })
    const res = await invoke<{
      status: string
      sizeBytes: number
      warnBytes: number
      blockBytes: number
    }>('binary:selectAndStage', null, {})
    expect(res.status).toBe('requiresConfirmation')
    expect(res.warnBytes).toBe(DEFAULT_BINARY_FILE_LIMITS.warnBytes)
    expect(res.blockBytes).toBe(DEFAULT_BINARY_FILE_LIMITS.blockBytes)
    expect(stageBinaryMock).not.toHaveBeenCalled()
  })

  it('returns blocked for 150 MB at default limits', async () => {
    currentLimits = undefined
    dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/big.bin']
    })
    fsStatMock.mockResolvedValueOnce({ size: 150 * 1024 * 1024 })
    const res = await invoke<{ status: string; blockBytes: number }>(
      'binary:selectAndStage',
      null,
      {}
    )
    expect(res.status).toBe('blocked')
    expect(res.blockBytes).toBe(DEFAULT_BINARY_FILE_LIMITS.blockBytes)
    expect(stageBinaryMock).not.toHaveBeenCalled()
  })

  it('honors custom limits (warn 1 MB / block 2 MB)', async () => {
    currentLimits = { warnBytes: 1 * 1024 * 1024, blockBytes: 2 * 1024 * 1024 }

    // 500 KB → staged silently
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/a'] })
    fsStatMock.mockResolvedValueOnce({ size: 500 * 1024 })
    stageBinaryMock.mockResolvedValueOnce({
      ref: 'a'.repeat(64) + '__a',
      originalName: 'a',
      sizeBytes: 500 * 1024,
      mimeType: 'application/octet-stream'
    })
    const small = await invoke<{ status: string }>('binary:selectAndStage', null, {})
    expect(small.status).toBe('staged')

    // 1.5 MB → requiresConfirmation
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/b'] })
    fsStatMock.mockResolvedValueOnce({ size: 1.5 * 1024 * 1024 })
    const mid = await invoke<{ status: string }>('binary:selectAndStage', null, {})
    expect(mid.status).toBe('requiresConfirmation')

    // 3 MB → blocked
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/c'] })
    fsStatMock.mockResolvedValueOnce({ size: 3 * 1024 * 1024 })
    const big = await invoke<{ status: string }>('binary:selectAndStage', null, {})
    expect(big.status).toBe('blocked')
  })

  it('re-invocation with { sourcePath, confirmed: true } stages without prompting again', async () => {
    currentLimits = undefined
    // No dialog this time: renderer passes the sourcePath directly
    fsStatMock.mockResolvedValueOnce({ size: 75 * 1024 * 1024 })
    stageBinaryMock.mockResolvedValueOnce({
      ref: 'a'.repeat(64) + '__y.bin',
      originalName: 'y.bin',
      sizeBytes: 75 * 1024 * 1024,
      mimeType: 'application/octet-stream'
    })
    const res = await invoke<{ status: string }>('binary:selectAndStage', null, {
      sourcePath: '/tmp/y.bin',
      confirmed: true
    })
    expect(res.status).toBe('staged')
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled()
  })

  it('returns cancelled when the user dismisses the picker', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const res = await invoke<{ status: string }>('binary:selectAndStage', null, {})
    expect(res.status).toBe('cancelled')
  })
})

describe('binary.ipc — stat / remove pass-through', () => {
  beforeEach(() => {
    handlers.clear()
    registerBinaryHandlers()
    statBinaryMock.mockReset()
    removeBinaryMock.mockReset()
  })

  it('binary:stat delegates to statBinary', async () => {
    statBinaryMock.mockResolvedValueOnce({ exists: true, sizeBytes: 42, mimeType: 'image/png' })
    const res = await invoke<{ exists: boolean; sizeBytes?: number }>('binary:stat', null, {
      ref: 'a'.repeat(64) + '__pic.png'
    })
    expect(res).toEqual({ exists: true, sizeBytes: 42, mimeType: 'image/png' })
  })

  it('binary:remove delegates to removeBinary', async () => {
    removeBinaryMock.mockResolvedValueOnce(true)
    const res = await invoke<{ removed: boolean }>('binary:remove', null, {
      ref: 'a'.repeat(64) + '__pic.png'
    })
    expect(res).toEqual({ removed: true })
  })
})
