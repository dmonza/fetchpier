import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the vi.mock factories (also hoisted) can reference them.
const h = vi.hoisted(() => ({
  DEFAULTS: { verifySsl: true, followRedirects: true } as Record<string, unknown>,
  active: '/ws' as string | null
}))

// ── Capture ipcMain.handle registrations ────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  },
  app: {
    getPath: (name: string): string =>
      name === 'documents' ? '/home/me/Documents' : '/tmp/userData'
  },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

// ── Filesystem ───────────────────────────────────────────────────────────────
const accessMock = vi.fn(async (_p: string): Promise<void> => {})
const readFileMock = vi.fn()
const writeFileMock = vi.fn(async (): Promise<void> => {})
const mkdirMock = vi.fn(async (): Promise<void> => {})
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: (...a: unknown[]) => accessMock(...(a as [string])),
      readFile: (...a: unknown[]) => readFileMock(...a),
      writeFile: (...a: unknown[]) => writeFileMock(...(a as [])),
      mkdir: (...a: unknown[]) => mkdirMock(...(a as []))
    }
  }
})

// ── Settings store ───────────────────────────────────────────────────────────
const loadHttpSettingsMock = vi.fn()
const updateHttpSettingsMock = vi.fn()
vi.mock('../config/workspace-settings-store', () => ({
  clearHttpSettingsCache: vi.fn(),
  loadHttpSettings: (...a: unknown[]) => loadHttpSettingsMock(...a),
  updateHttpSettings: (...a: unknown[]) => updateHttpSettingsMock(...a)
}))

vi.mock('../config/defaults', () => ({ DEFAULT_WORKSPACE_HTTP_SETTINGS: h.DEFAULTS }))

// ── Active-workspace singleton (the source of truth the handlers read) ────────
type FakeHandle = { path: string; tree: { requestsRoot: () => string } }
const fakeHandle = (): FakeHandle => ({
  path: h.active as string,
  tree: { requestsRoot: (): string => `${h.active}/requests` }
})
vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: (): FakeHandle => {
    if (!h.active) throw new Error('No active workspace')
    return fakeHandle()
  },
  getActiveWorkspaceHandle: (): FakeHandle | null => (h.active ? fakeHandle() : null),
  setActiveWorkspace: vi.fn((p: string | null) => {
    h.active = p
  })
}))

// ── Collaborators: no-ops ─────────────────────────────────────────────────────
vi.mock('@fetchpier/core', () => ({
  workspace: {
    createWorkspace: vi.fn(async () => ({ gitignoreCreated: false })),
    // recent-workspaces.ts routes its write through this — funnel it into the
    // same mocked fs.writeFile so the existing "last write" assertions below
    // keep observing the real payload (atomic-write coverage gap).
    atomicWriteFile: vi.fn(async (...a: unknown[]) => {
      await writeFileMock(...(a as []))
    })
  }
}))
vi.mock('../watcher', () => ({ startWatcher: vi.fn(), stopWatcher: vi.fn() }))
vi.mock('./request.ipc', () => ({ setActiveWorkspaceForHttp: vi.fn() }))
vi.mock('../state/ui-state-store', () => ({ clearWorkspace: vi.fn(), loadFromWorkspace: vi.fn() }))
vi.mock('../state/tree-state-store', () => ({
  clearWorkspace: vi.fn(),
  loadFromWorkspace: vi.fn()
}))
vi.mock('../state/workspace-state-store', () => ({
  clearWorkspace: vi.fn(),
  loadFromWorkspace: vi.fn()
}))
vi.mock('./filesystem.ipc', () => ({ requestsRootPath: (p: string): string => `${p}/requests` }))

// Import after mocks
import { dialog } from 'electron'
import { registerWorkspaceHandlers } from './workspace.ipc'
import { workspace as coreWorkspace } from '@fetchpier/core'
import * as treeStateStore from '../state/tree-state-store'
import type { OpenPathResult, RestoreResult, WorkspaceOpenStrings } from '../../shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return (await fn(...args)) as T
}

// Mutable fake disk contents for the userData JSON file.
let recentStore: { path: string; recent: string[] }

beforeEach(() => {
  handlers.clear()
  registerWorkspaceHandlers()
  h.active = '/ws'
  recentStore = { path: '/ws', recent: ['/ws', '/old'] }
  accessMock.mockReset()
  accessMock.mockResolvedValue(undefined)
  writeFileMock.mockReset()
  writeFileMock.mockResolvedValue(undefined)
  mkdirMock.mockReset()
  loadHttpSettingsMock.mockReset()
  updateHttpSettingsMock.mockReset()
  readFileMock.mockReset()
  readFileMock.mockImplementation(async (p: string) => {
    if (typeof p === 'string' && p.includes('last-workspace')) return JSON.stringify(recentStore)
    throw new Error(`unexpected readFile: ${p}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace.ipc — active-workspace-scoped handlers', () => {
  it('getHttpSettings returns defaults when there is no active workspace', async () => {
    h.active = null
    const res = await invoke('workspace:getHttpSettings', null)
    expect(res).toEqual(h.DEFAULTS)
    expect(loadHttpSettingsMock).not.toHaveBeenCalled()
  })

  it('getHttpSettings loads settings for the active workspace', async () => {
    loadHttpSettingsMock.mockResolvedValueOnce({ verifySsl: false })
    const res = await invoke('workspace:getHttpSettings', null)
    expect(res).toEqual({ verifySsl: false })
    expect(loadHttpSettingsMock).toHaveBeenCalledWith('/ws')
  })

  it('updateHttpSettings delegates to the store for the active workspace', async () => {
    updateHttpSettingsMock.mockResolvedValueOnce({ verifySsl: false })
    const res = await invoke('workspace:updateHttpSettings', null, { verifySsl: false })
    expect(res).toEqual({ verifySsl: false })
    expect(updateHttpSettingsMock).toHaveBeenCalledWith('/ws', { verifySsl: false })
  })

  it('getRequestsRoot resolves from the active workspace', async () => {
    const res = await invoke<string>('workspace:getRequestsRoot', null)
    expect(res).toBe('/ws/requests')
  })
})

describe('workspace.ipc — openPath', () => {
  it('opens an initialized workspace', async () => {
    // Both the folder and its `.fetchpier/` resolve.
    accessMock.mockResolvedValue(undefined)
    const res = await invoke<OpenPathResult>('workspace:openPath', null, '/ws')
    expect(res).toEqual({ ok: true, path: '/ws' })
  })

  it('returns not-found and prunes the recent when the folder is gone', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'))
    const res = await invoke<OpenPathResult>('workspace:openPath', null, '/old')
    expect(res).toEqual({ ok: false, reason: 'not-found' })
    // The stale entry was removed from the recent list.
    const lastWrite = writeFileMock.mock.calls.at(-1) as unknown as [string, string]
    expect(JSON.parse(lastWrite[1]).recent).not.toContain('/old')
  })

  it('returns not-a-workspace and prunes the recent when `.fetchpier/` is missing', async () => {
    // The folder exists, but it has no `.fetchpier/`.
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('.fetchpier')) throw new Error('ENOENT')
    })
    const res = await invoke<OpenPathResult>('workspace:openPath', null, '/notws')
    expect(res).toEqual({ ok: false, reason: 'not-a-workspace' })
    const lastWrite = writeFileMock.mock.calls.at(-1) as unknown as [string, string]
    expect(JSON.parse(lastWrite[1]).recent).not.toContain('/notws')
  })
})

/*
 * REQ-0122 — the launch-time restore applies the same test as openPath above.
 *
 * It used to check only that the folder existed, then run the idempotent layout
 * creation over it. Against a folder whose contents had been deleted that
 * silently rebuilt a skeleton — settings, environments/, requests/ — and opened
 * it as if the workspace had survived. The assertion that matters here is not
 * the returned reason but that `createWorkspace` is never reached: the layout
 * creation is what manufactures the evidence, so a future reordering that puts
 * it back above the guards has to fail.
 */
describe('workspace.ipc — getLast refuses a workspace that is gone', () => {
  const recentAfterPrune = (): string[] => {
    const lastWrite = writeFileMock.mock.calls.at(-1) as unknown as [string, string]
    return JSON.parse(lastWrite[1]).recent
  }

  it('restores a healthy workspace', async () => {
    recentStore = { path: '/ws', recent: ['/ws'] }
    accessMock.mockResolvedValue(undefined)
    const res = await invoke<RestoreResult>('workspace:getLast', null)
    expect(res).toEqual({ ok: true, path: '/ws' })
    expect(vi.mocked(coreWorkspace.createWorkspace)).toHaveBeenCalled()
  })

  it('refuses, prunes and writes nothing when `.fetchpier/` is missing', async () => {
    recentStore = { path: '/gutted', recent: ['/gutted', '/other'] }
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('.fetchpier')) throw new Error('ENOENT')
    })
    vi.mocked(coreWorkspace.createWorkspace).mockClear()

    const res = await invoke<RestoreResult>('workspace:getLast', null)

    expect(res).toEqual({ ok: false, reason: 'not-a-workspace' })
    // The regression that matters: no skeleton was rebuilt in that folder.
    expect(vi.mocked(coreWorkspace.createWorkspace)).not.toHaveBeenCalled()
    expect(recentAfterPrune()).not.toContain('/gutted')
  })

  it('refuses, prunes and writes nothing when the folder is gone', async () => {
    recentStore = { path: '/deleted', recent: ['/deleted', '/other'] }
    accessMock.mockRejectedValue(new Error('ENOENT'))
    vi.mocked(coreWorkspace.createWorkspace).mockClear()

    const res = await invoke<RestoreResult>('workspace:getLast', null)

    expect(res).toEqual({ ok: false, reason: 'not-found' })
    expect(vi.mocked(coreWorkspace.createWorkspace)).not.toHaveBeenCalled()
    expect(recentAfterPrune()).not.toContain('/deleted')
  })

  // Pruning clears the saved pointer too, so the next launch attempts nothing —
  // otherwise the same folder would be re-refused on every start.
  it('clears the saved pointer when it is the entry being pruned', async () => {
    recentStore = { path: '/gutted', recent: ['/gutted'] }
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('.fetchpier')) throw new Error('ENOENT')
    })
    await invoke<RestoreResult>('workspace:getLast', null)
    const lastWrite = writeFileMock.mock.calls.at(-1) as unknown as [string, string]
    expect(JSON.parse(lastWrite[1]).path).toBe('')
  })

  it('reports nothing to restore without pruning anything', async () => {
    recentStore = { path: '', recent: ['/somewhere'] }
    vi.mocked(coreWorkspace.createWorkspace).mockClear()
    writeFileMock.mockClear()

    const res = await invoke<RestoreResult>('workspace:getLast', null)

    expect(res).toEqual({ ok: false, reason: 'none' })
    expect(vi.mocked(coreWorkspace.createWorkspace)).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  // A filesystem root is never a workspace — same refusal as a missing marker.
  it('refuses a filesystem root', async () => {
    recentStore = { path: '/', recent: ['/'] }
    accessMock.mockResolvedValue(undefined)
    vi.mocked(coreWorkspace.createWorkspace).mockClear()

    const res = await invoke<RestoreResult>('workspace:getLast', null)

    expect(res).toEqual({ ok: false, reason: 'not-a-workspace' })
    expect(vi.mocked(coreWorkspace.createWorkspace)).not.toHaveBeenCalled()
  })
})

// Electron 43 defaults a `defaultPath`-less dialog to the Downloads folder, which is not
// where workspaces live. The picker states its own starting point instead.
describe('workspace.ipc — open/create picker default path', () => {
  const openStrings = {
    createTitle: 'Open or create',
    rootRejectTitle: '',
    rootRejectDetail: '',
    confirmTitle: '',
    confirmDetail: '',
    confirmCreate: '',
    confirmCancel: ''
  }

  const defaultPathOf = async (): Promise<string | undefined> => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: []
    } as unknown as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
    await invoke<string | null>('workspace:open', null, openStrings)
    const opts = vi.mocked(dialog.showOpenDialog).mock.calls.at(-1)?.[0] as
      { defaultPath?: string } | undefined
    return opts?.defaultPath
  }

  it('starts in the parent of the current workspace, not inside it', async () => {
    recentStore = { path: '/home/me/projects/api-clients', recent: [] }
    expect(await defaultPathOf()).toBe('/home/me/projects')
  })

  it('falls back to Documents when no workspace is selected', async () => {
    recentStore = { path: '', recent: ['/home/me/projects/api-clients'] }
    expect(await defaultPathOf()).toBe('/home/me/Documents')
  })

  it('falls back to Documents when the stored parent no longer exists', async () => {
    recentStore = { path: '/gone/api-clients', recent: [] }
    accessMock.mockImplementation(async (p: string) => {
      if (p === '/gone') throw new Error('ENOENT')
    })
    expect(await defaultPathOf()).toBe('/home/me/Documents')
  })
})

// ── REQ-0113 §6.5 — expansion state belongs to the workspace that is open ────
//
// The tree-state store is re-pointed at the new workspace by exactly one call.
// `getLast` and `openPath` made it; `open`/`create` did not, so after switching
// A → B through the folder dialog the store stayed bound to A: B's renderer read
// A's expansion set, and expanding a folder in B wrote it into A's state file.
// Silent cross-workspace corruption, not a lost preference.
//
// Asserted per entry point on purpose (REQ-0113 §9.2): a test that covered one
// representative is exactly what let this survive three entry points.
describe('workspace.ipc — every entry point re-points the tree-state store', () => {
  const openStrings = {
    createTitle: 'Open or create',
    rootRejectTitle: '',
    rootRejectDetail: '',
    confirmTitle: '',
    confirmDetail: '',
    confirmCreate: '',
    confirmCancel: ''
  }

  /** Drive one entry point and return the paths the tree store was pointed at. */
  const treeStateTargets = async (drive: () => Promise<unknown>): Promise<unknown[]> => {
    vi.mocked(treeStateStore.loadFromWorkspace).mockClear()
    await drive()
    return vi.mocked(treeStateStore.loadFromWorkspace).mock.calls.map((c) => c[0])
  }

  const pickFolder = (path: string): void => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path]
    } as unknown as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
  }

  it('workspace:open points the store at the picked workspace', async () => {
    pickFolder('/ws-b')
    expect(await treeStateTargets(() => invoke('workspace:open', null, openStrings))).toEqual([
      '/ws-b'
    ])
  })

  it('workspace:create points the store at the picked workspace', async () => {
    pickFolder('/ws-b')
    expect(await treeStateTargets(() => invoke('workspace:create', null, openStrings))).toEqual([
      '/ws-b'
    ])
  })

  it('workspace:openPath points the store at the opened workspace', async () => {
    expect(await treeStateTargets(() => invoke('workspace:openPath', null, '/ws-b'))).toEqual([
      '/ws-b'
    ])
  })

  it('workspace:getLast points the store at the restored workspace', async () => {
    recentStore = { path: '/ws-b', recent: ['/ws-b'] }
    expect(await treeStateTargets(() => invoke('workspace:getLast', null))).toEqual(['/ws-b'])
  })
})

/*
 * REQ-0121 CA-01/CA-04 — the default-environment seed fires on creation only.
 *
 * Every entry point re-runs `createWorkspace` defensively (the .gitignore seed),
 * so the flag is the only thing separating "create a workspace here" from "open
 * the one that is already here". Asserted per entry point on purpose: a single
 * representative is exactly what would let a seeding open path survive, and a
 * seeding open path resurrects an environment the user deliberately deleted.
 */
describe('workspace.ipc — default-environment seed', () => {
  // The full string set: unlike the other suites, this one drives the
  // create-confirmation dialog, which reads the `create*` members.
  const openStrings: WorkspaceOpenStrings = {
    rootRejectTitle: '',
    rootRejectMessage: '',
    rootRejectDetail: '',
    rootRejectOk: '',
    createTitle: 'Open or create',
    createMessage: 'Create a workspace in {{name}}?',
    createDetail: '',
    createConfirm: 'Create',
    createCancel: 'Cancel'
  }

  /** Drive one entry point and return the options `createWorkspace` was given. */
  const seedOptionOf = async (drive: () => Promise<unknown>): Promise<unknown> => {
    const spy = vi.mocked(coreWorkspace.createWorkspace)
    spy.mockClear()
    await drive()
    expect(spy).toHaveBeenCalledTimes(1)
    return spy.mock.calls[0]?.[1]
  }

  const pickFolder = (path: string): void => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path]
    } as unknown as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
  }

  /** Make `.fetchpier/` absent, so the picked folder reads as a new workspace. */
  const folderIsNotAWorkspace = (): void => {
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('.fetchpier')) throw new Error('ENOENT')
    })
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0
    } as unknown as Awaited<ReturnType<typeof dialog.showMessageBox>>)
  }

  it('seeds when the picked folder is not yet a workspace', async () => {
    pickFolder('/ws-new')
    folderIsNotAWorkspace()
    expect(await seedOptionOf(() => invoke('workspace:create', null, openStrings))).toEqual({
      seedDefaultEnvironment: true
    })
  })

  it('does not seed when the picked folder is already a workspace', async () => {
    pickFolder('/ws-b')
    expect(await seedOptionOf(() => invoke('workspace:open', null, openStrings))).toEqual({
      seedDefaultEnvironment: false
    })
  })

  it('does not seed when opening a recent workspace', async () => {
    expect(await seedOptionOf(() => invoke('workspace:openPath', null, '/ws-b'))).toEqual({
      seedDefaultEnvironment: false
    })
  })

  it('does not seed on the silent restore at startup', async () => {
    recentStore = { path: '/ws-b', recent: ['/ws-b'] }
    expect(await seedOptionOf(() => invoke('workspace:getLast', null))).toEqual({
      seedDefaultEnvironment: false
    })
  })
})
