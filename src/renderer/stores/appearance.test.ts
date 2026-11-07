/**
 * The appearance store: what is in force, live drafts while editing, when
 * changes are written, the session snapshot behind *Revert changes*, and the
 * save-error path (requirement *Dynamic color themes* §6.5, §6.11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppearancePalettes, AppearanceState } from '../../shared/types'
import { useThemeStore } from './theme'
import { COMMIT_DELAY_MS, useAppearanceStore } from './appearance'

const ORIGINAL: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: 'original' },
  dark: { selected: 'original' }
}
const withLight = (selected: string): AppearancePalettes => ({ ...ORIGINAL, light: { selected } })

let set: ReturnType<typeof vi.fn>
let setWorkspace: ReturnType<typeof vi.fn>
let setNativeTheme: ReturnType<typeof vi.fn>

function stateFor(
  prefs: AppearancePalettes,
  workspace: AppearancePalettes | null = null
): AppearanceState {
  return {
    prefs,
    workspace,
    palettes: {
      light: prefs.light.selected === 'original' ? null : { canvas: '#fefefe' },
      dark: prefs.dark.selected === 'original' ? null : { canvas: '#010101' }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  set = vi.fn((prefs: AppearancePalettes) => Promise.resolve(stateFor(prefs)))
  setWorkspace = vi.fn((ws: AppearancePalettes) => Promise.resolve(stateFor(ORIGINAL, ws)))
  setNativeTheme = vi.fn(() => Promise.resolve())
  vi.stubGlobal('window', {
    ...window,
    api: {
      appearance: {
        initial: { light: null, dark: null },
        get: vi.fn(() => Promise.resolve(stateFor(ORIGINAL))),
        set,
        setWorkspace,
        onChanged: vi.fn(() => () => undefined)
      },
      theme: { setNativeTheme, onSystemChanged: vi.fn(), initialResolved: 'light' }
    }
  })
  useAppearanceStore.getState().reset()
  useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const store = (): ReturnType<typeof useAppearanceStore.getState> => useAppearanceStore.getState()

describe('loading', () => {
  it('starts from the palettes handed to the window at launch, then adopts the stored preferences', async () => {
    window.api.appearance.initial = { light: { canvas: '#fafafa' }, dark: null }
    store().reset()
    expect(store().palettes.light).toEqual({ canvas: '#fafafa' })
    await store().load()
    expect(store().prefs).toEqual(ORIGINAL)
  })
})

describe('commit timing', () => {
  it('writes nothing while a drag is under way and once on release (CA-16)', async () => {
    store().beginDrag('light')
    for (let i = 0; i < 30; i++)
      store().preview('light', { canvas: `#0000${(10 + i).toString(16)}` })
    expect(set).not.toHaveBeenCalled()
    expect(store().drafts.light).toEqual({ canvas: '#000027' })

    await store().endDrag(withLight('custom'))
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(withLight('custom'))
  })

  it('batches keyboard changes: at most two writes while a key is held for 2 s (CA-17)', async () => {
    for (let t = 0; t < 2000; t += 33) {
      store().scheduleCommit(withLight(t % 2 ? 'ocean' : 'forest'))
      vi.advanceTimersByTime(33)
    }
    expect(set.mock.calls.length).toBeLessThanOrEqual(2)
    vi.advanceTimersByTime(COMMIT_DELAY_MS)
    await Promise.resolve()
    expect(set.mock.calls.length).toBeLessThanOrEqual(2)
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ light: expect.any(Object) }))
  })

  it('writes a pending keyboard change at once when flushed (blur, tab change, close)', async () => {
    store().scheduleCommit(withLight('ocean'))
    expect(set).not.toHaveBeenCalled()
    await store().flush()
    expect(set).toHaveBeenCalledWith(withLight('ocean'))
    vi.advanceTimersByTime(COMMIT_DELAY_MS * 2)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('clears the draft once the change is saved', async () => {
    store().preview('light', { canvas: '#fefefe' })
    await store().commit(withLight('ocean'))
    expect(store().drafts.light).toBeUndefined()
    expect(store().palettes.light).toEqual({ canvas: '#fefefe' })
  })
})

describe('drag cancel (CA-20)', () => {
  it('drops the drag without writing and hands back where it started', () => {
    store().beginDrag('light')
    store().preview('light', { canvas: '#123456' })
    const start = store().cancelDrag()
    expect(start).toEqual(ORIGINAL)
    expect(store().drafts.light).toBeUndefined()
    expect(store().dragging).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })
})

describe('revert (CA-18, CA-19)', () => {
  it('is unavailable until something differs from the snapshot', async () => {
    store().beginSession('light')
    expect(store().canRevert('light')).toBe(false)
    await store().commit(withLight('ocean'))
    expect(store().canRevert('light')).toBe(true)
  })

  it('counts a mode change as something to revert', () => {
    store().beginSession('light')
    expect(store().canRevert('dark')).toBe(true)
  })

  it('returns palettes and mode to the snapshot, saving them', async () => {
    useThemeStore.setState({ theme: 'light' })
    store().beginSession('light')
    await store().commit({ ...withLight('ocean'), dark: { selected: 'forest' } })
    useThemeStore.getState().setTheme('dark')
    setNativeTheme.mockClear()

    await store().revert()
    expect(set).toHaveBeenLastCalledWith(ORIGINAL)
    expect(store().prefs).toEqual(ORIGINAL)
    expect(setNativeTheme).toHaveBeenCalledWith('light')
    expect(store().canRevert(useThemeStore.getState().theme)).toBe(false)
  })

  it('does not touch the mode when it did not change', async () => {
    store().beginSession('system')
    useThemeStore.setState({ theme: 'system' })
    await store().commit(withLight('ocean'))
    await store().revert()
    expect(setNativeTheme).not.toHaveBeenCalled()
  })

  it('drops the snapshot when the session ends, after flushing', async () => {
    store().beginSession('light')
    store().scheduleCommit(withLight('forest'))
    await store().endSession()
    expect(set).toHaveBeenCalledWith(withLight('forest'))
    expect(store().snapshot).toBeNull()
  })
})

describe('changes from other windows', () => {
  it('adopts a broadcast change', () => {
    store().applyExternal(stateFor(withLight('ocean')))
    expect(store().prefs).toEqual(withLight('ocean'))
    expect(store().palettes.light).toEqual({ canvas: '#fefefe' })
  })

  it('never makes a dragged control jump', () => {
    store().beginDrag('light')
    store().preview('light', { canvas: '#123456' })
    store().applyExternal(stateFor(withLight('forest')))
    expect(store().drafts.light).toEqual({ canvas: '#123456' })
  })
})

describe('save failure (CA-33)', () => {
  it('keeps the palette applied, reports the failure and retries', async () => {
    set.mockImplementationOnce(() => Promise.reject(new Error('EACCES')))
    store().preview('light', { canvas: '#fefefe' })
    await store().commit(withLight('ocean'))
    expect(store().saveError).toBe(true)
    expect(store().drafts.light).toEqual({ canvas: '#fefefe' })
    expect(store().prefs).toEqual(withLight('ocean'))

    await store().retry()
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith(withLight('ocean'))
    expect(store().saveError).toBe(false)
    expect(store().drafts.light).toBeUndefined()
  })
})

// Requirement *Workspace color palettes* §6.2–§6.4: the same lifecycle, applied
// to the open workspace's palettes.
describe('the workspace scope', () => {
  const INHERIT: AppearancePalettes = {
    schemaVersion: 1,
    light: { selected: 'inherit' },
    dark: { selected: 'inherit' }
  }
  const forestDark: AppearancePalettes = { ...INHERIT, dark: { selected: 'forest' } }

  beforeEach(() => {
    useAppearanceStore.setState({ workspace: INHERIT })
  })

  it('adopts the workspace from what main reports', async () => {
    window.api.appearance.get = vi.fn(() => Promise.resolve(stateFor(ORIGINAL, forestDark)))
    await store().load()
    expect(store().workspace).toEqual(forestDark)
    store().applyExternal(stateFor(ORIGINAL, null))
    expect(store().workspace).toBeNull()
  })

  it('saves workspace changes through the workspace write, never the user one', async () => {
    await store().commit(forestDark, 'workspace')
    expect(setWorkspace).toHaveBeenCalledWith(forestDark)
    expect(set).not.toHaveBeenCalled()
    expect(store().workspace).toEqual(forestDark)
  })

  it('batches workspace keyboard steps into one workspace write', async () => {
    store().scheduleCommit(forestDark, 'workspace')
    store().scheduleCommit({ ...forestDark, light: { selected: 'paper' } }, 'workspace')
    vi.advanceTimersByTime(COMMIT_DELAY_MS)
    await Promise.resolve()
    expect(setWorkspace).toHaveBeenCalledTimes(1)
    expect(setWorkspace).toHaveBeenCalledWith({ ...forestDark, light: { selected: 'paper' } })
  })

  it('reverts only the workspace palettes, never the mode (CA-15)', async () => {
    useThemeStore.setState({ theme: 'light' })
    store().beginSession('light', 'workspace')
    await store().commit(forestDark, 'workspace')
    expect(store().canRevert('dark')).toBe(true)
    useThemeStore.setState({ theme: 'dark' })
    setNativeTheme.mockClear()
    await store().revert()
    expect(setWorkspace).toHaveBeenLastCalledWith(INHERIT)
    expect(set).not.toHaveBeenCalled()
    expect(setNativeTheme).not.toHaveBeenCalled()
    expect(store().canRevert('dark')).toBe(false)
  })

  it('does not count a mode change as something a workspace session reverts', () => {
    store().beginSession('light', 'workspace')
    expect(store().canRevert('dark')).toBe(false)
  })

  it('cancels a workspace drag back to where it started', () => {
    store().beginDrag('dark', 'workspace')
    store().preview('dark', { canvas: '#123456' })
    store().cancelDrag()
    expect(store().workspace).toEqual(INHERIT)
    expect(store().drafts.dark).toBeUndefined()
  })

  it('surfaces a failed workspace save and retries the workspace write (CA-07)', async () => {
    setWorkspace.mockImplementationOnce(() => Promise.reject(new Error('EACCES')))
    await store().commit(forestDark, 'workspace')
    expect(store().saveError).toBe(true)
    await store().retry()
    expect(setWorkspace).toHaveBeenCalledTimes(2)
    expect(set).not.toHaveBeenCalled()
    expect(store().saveError).toBe(false)
  })
})

// Settings → Appearance shows the user's palette for a mode the workspace
// overrides (requirement *Workspace color palettes* §6.3).
describe('display override', () => {
  it('holds a palette to show for one mode until cleared', () => {
    store().setDisplayOverride({ mode: 'dark', tokens: { canvas: '#0a0a0a' } })
    expect(store().displayOverride).toEqual({ mode: 'dark', tokens: { canvas: '#0a0a0a' } })
    store().setDisplayOverride(null)
    expect(store().displayOverride).toBeNull()
  })

  it('survives a save, unlike a draft', async () => {
    store().setDisplayOverride({ mode: 'dark', tokens: { canvas: '#0a0a0a' } })
    await store().commit(withLight('ocean'))
    expect(store().displayOverride).not.toBeNull()
  })
})
