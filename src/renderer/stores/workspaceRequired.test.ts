import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * REQ Application menu coherence on macOS §6.11 — CA-13.
 *
 * `New Request` stays available with no workspace open, so every save path has
 * to lead somewhere. This is the decision that replaces the silent no-op in the
 * editor and the silent discard in the unsaved-changes prompt.
 *
 * The modules are imported per test because `stores/workspace` pulls the i18n
 * bootstrap, which pushes to the bridge at import time.
 */

type Mod = typeof import('./workspaceRequired')
type WsMod = typeof import('./workspace')

let mod: Mod
let workspaceStore: WsMod['useWorkspaceStore']

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('window', {
    api: {
      window: { setCloseDialogStrings: vi.fn() },
      menu: { setLabels: vi.fn(), setState: vi.fn() },
      appSettings: { get: vi.fn().mockResolvedValue({ language: 'en' }) },
      locale: { get: vi.fn().mockResolvedValue('en') }
    }
  })
  mod = await import('./workspaceRequired')
  workspaceStore = (await import('./workspace')).useWorkspaceStore
  workspaceStore.setState({ workspacePath: null, requestsRoot: null })
  mod.useWorkspaceRequiredStore.setState({ pending: null })
})

describe('withWorkspace', () => {
  it('runs the save immediately when a workspace is already open', async () => {
    workspaceStore.setState({ workspacePath: '/ws' })
    const proceed = vi.fn()

    await mod.withWorkspace(proceed)

    expect(proceed).toHaveBeenCalledTimes(1)
    expect(mod.useWorkspaceRequiredStore.getState().pending).toBeNull()
  })

  it('parks the save and asks for a workspace when none is open', async () => {
    const proceed = vi.fn()

    await mod.withWorkspace(proceed)

    expect(proceed).not.toHaveBeenCalled()
    expect(mod.useWorkspaceRequiredStore.getState().pending).not.toBeNull()
  })

  it('runs the parked save once the prompt resolves', async () => {
    const proceed = vi.fn()
    await mod.withWorkspace(proceed)

    await mod.useWorkspaceRequiredStore.getState().pending?.onProceed()

    expect(proceed).toHaveBeenCalledTimes(1)
  })

  it('drops the parked save on cancel without running it', async () => {
    const proceed = vi.fn()
    await mod.withWorkspace(proceed)

    mod.useWorkspaceRequiredStore.getState().clear()

    expect(mod.useWorkspaceRequiredStore.getState().pending).toBeNull()
    expect(proceed).not.toHaveBeenCalled()
  })

  it('awaits an async save so the caller can sequence work after it', async () => {
    workspaceStore.setState({ workspacePath: '/ws' })
    const order: string[] = []

    await mod.withWorkspace(async () => {
      await Promise.resolve()
      order.push('saved')
    })
    order.push('after')

    expect(order).toEqual(['saved', 'after'])
  })
})
