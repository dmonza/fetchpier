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
let setNativeTheme: ReturnType<typeof vi.fn>

function stateFor(prefs: AppearancePalettes): AppearanceState {
  return {
    prefs,
    palettes: {
      light: prefs.light.selected === 'original' ? null : { canvas: '#fefefe' },
      dark: prefs.dark.selected === 'original' ? null : { canvas: '#010101' }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  set = vi.fn((prefs: AppearancePalettes) => Promise.resolve(stateFor(prefs)))
  setNativeTheme = vi.fn(() => Promise.resolve())
  vi.stubGlobal('window', {
    ...window,
    api: {
      appearance: {
        initial: { light: null, dark: null },
        get: vi.fn(() => Promise.resolve(stateFor(ORIGINAL))),
        set,
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
