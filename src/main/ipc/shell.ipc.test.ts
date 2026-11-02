/**
 * Integration: the `shell:revealPath` handler validates workspace containment and
 * existence before asking the OS file manager to highlight a path. Electron's
 * `shell` and the active-workspace handle are the only mocked seams; the path
 * checks run against a real tmpdir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  shell: { showItemInFolder: mocks.showItemInFolder }
}))

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({ path: state.root })
}))

const { registerShellHandlers, resolveRevealTarget } = await import('./shell.ipc')
registerShellHandlers()

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler({}, ...args)
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'fp-shell-'))
  mocks.showItemInFolder.mockClear()
})
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
})

describe('resolveRevealTarget (pure containment)', () => {
  it('returns the resolved target for a path inside the workspace', () => {
    expect(resolveRevealTarget('/ws', '/ws/requests/a.http')).toBe(resolve('/ws/requests/a.http'))
  })

  it('throws for a path that escapes the workspace', () => {
    expect(() => resolveRevealTarget('/ws', '/ws/../evil')).toThrow('PATH_OUTSIDE_WORKSPACE')
  })
})

describe('shell:revealPath', () => {
  it('reveals an existing file inside the workspace', async () => {
    const file = join(state.root, 'requests', 'a.http')
    writeFileSync(join(state.root, 'a.http'), 'x') // a real file at the resolved target
    const target = join(state.root, 'a.http')
    await invoke('shell:revealPath', target)
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(resolve(target))
    void file
  })

  it('rejects a path outside the workspace and does not reveal anything', async () => {
    await expect(invoke('shell:revealPath', join(state.root, '..', 'evil.http'))).rejects.toThrow(
      'PATH_OUTSIDE_WORKSPACE'
    )
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('rejects a non-existent path inside the workspace', async () => {
    await expect(invoke('shell:revealPath', join(state.root, 'missing.http'))).rejects.toThrow()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })
})
