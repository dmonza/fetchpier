import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The store reads window.api on toggle()/setHeight()/popout(), so the global
// must exist before importing the module. vi.resetModules() inside beforeEach
// guarantees a fresh module evaluation per test.

let store: typeof import('./activityPanel').useActivityPanelStore
let clampHeight: typeof import('./activityPanel').clampHeight
let computeDefaultHeight: typeof import('./activityPanel').computeDefaultHeight

function makeApi() {
  return {
    appSettings: {
      set: vi.fn().mockResolvedValue({})
    },
    activityPanel: {
      popout: vi.fn().mockResolvedValue({ ok: true }),
      dock: vi.fn().mockResolvedValue({ ok: true }),
      focusPopout: vi.fn().mockResolvedValue(true),
      isPoppedOut: vi.fn().mockResolvedValue(false),
      onPopoutChanged: vi.fn(() => vi.fn())
    }
  }
}

let api: ReturnType<typeof makeApi>

beforeEach(async () => {
  vi.resetModules()
  api = makeApi()
  vi.stubGlobal('window', { api, innerHeight: 1000 })
  const mod = await import('./activityPanel')
  store = mod.useActivityPanelStore
  clampHeight = mod.clampHeight
  computeDefaultHeight = mod.computeDefaultHeight
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('activityPanel store', () => {
  it('toggle flips isOpen when not detached', () => {
    expect(store.getState().isOpen).toBe(false)
    store.getState().toggle()
    expect(store.getState().isOpen).toBe(true)
    store.getState().toggle()
    expect(store.getState().isOpen).toBe(false)
  })

  it('toggle while detached focuses the popout instead of opening the docked panel', () => {
    store.setState({ isDetached: true, isOpen: false })
    store.getState().toggle()
    expect(store.getState().isOpen).toBe(false)
    expect(api.activityPanel.focusPopout).toHaveBeenCalledTimes(1)
  })

  it('open() is a no-op while detached', () => {
    store.setState({ isDetached: true })
    store.getState().open()
    expect(store.getState().isOpen).toBe(false)
  })

  it('hydrate() seeds heightPx from AppSettings.activityPanel', () => {
    store.getState().hydrate({ heightPx: 420 })
    expect(store.getState().heightPx).toBe(420)
  })

  it('hydrate() clamps a stored height taller than the room the window leaves (HIS-19)', () => {
    // innerHeight is 1000 → max is 1000 - 100 reserved chrome.
    store.getState().hydrate({ heightPx: 1300 })
    expect(store.getState().heightPx).toBe(900)
  })

  it('hydrate() raises a stored height below the minimum to the minimum (HIS-19)', () => {
    store.getState().hydrate({ heightPx: 50 })
    expect(store.getState().heightPx).toBe(200)
  })

  it('hydrate() keeps a stored height exactly at the maximum (HIS-19 boundary)', () => {
    store.getState().hydrate({ heightPx: 900 })
    expect(store.getState().heightPx).toBe(900)
  })

  it('hydrate() does not persist the clamped height back (HIS-19)', () => {
    vi.useFakeTimers()
    try {
      store.getState().hydrate({ heightPx: 1300 })
      vi.advanceTimersByTime(1000)
      expect(api.appSettings.set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrate() with missing settings leaves heightPx null', () => {
    store.getState().hydrate(undefined)
    expect(store.getState().heightPx).toBeNull()
  })

  it('applyPopoutEvent({detached:true}) closes the docked panel', () => {
    store.setState({ isOpen: true, isDetached: false })
    store.getState().applyPopoutEvent({ detached: true })
    expect(store.getState()).toMatchObject({ isOpen: false, isDetached: true })
  })

  it('applyPopoutEvent({detached:false, openAfter:true}) re-opens the docked panel', () => {
    store.setState({ isOpen: false, isDetached: true })
    store.getState().applyPopoutEvent({ detached: false, openAfter: true })
    expect(store.getState()).toMatchObject({ isOpen: true, isDetached: false })
  })

  it('applyPopoutEvent({detached:false, openAfter:false}) leaves the docked panel closed', () => {
    store.setState({ isOpen: false, isDetached: true })
    store.getState().applyPopoutEvent({ detached: false })
    expect(store.getState()).toMatchObject({ isOpen: false, isDetached: false })
  })

  it('setHeight clamps to the minimum (200)', () => {
    store.getState().setHeight(50, { persist: false })
    expect(store.getState().heightPx).toBe(200)
  })

  it('setHeight clamps to (windowHeight - 100)', () => {
    // window.innerHeight = 1000 → max = 900
    store.getState().setHeight(5000, { persist: false })
    expect(store.getState().heightPx).toBe(900)
  })

  it('setHeight debounces the persist call to window.api.appSettings.set', async () => {
    vi.useFakeTimers()
    try {
      store.getState().setHeight(450)
      store.getState().setHeight(460)
      store.getState().setHeight(470)
      expect(api.appSettings.set).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(api.appSettings.set).toHaveBeenCalledTimes(1)
      expect(api.appSettings.set).toHaveBeenLastCalledWith({
        activityPanel: { heightPx: 470 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('setHeight with persist:false does not call window.api.appSettings.set', () => {
    vi.useFakeTimers()
    try {
      store.getState().setHeight(450, { persist: false })
      vi.advanceTimersByTime(1000)
      expect(api.appSettings.set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('popout() flips isOpen→false and isDetached→true on success', async () => {
    store.setState({ isOpen: true, isDetached: false })
    await store.getState().popout()
    expect(store.getState()).toMatchObject({ isOpen: false, isDetached: true })
  })

  it('popout() leaves state untouched when main rejects', async () => {
    store.setState({ isOpen: true, isDetached: false })
    api.activityPanel.popout.mockResolvedValueOnce({ ok: false, reason: 'already-detached' })
    await store.getState().popout()
    expect(store.getState()).toMatchObject({ isOpen: true, isDetached: false })
  })

  it('clampHeight rounds and bounds the input', () => {
    expect(clampHeight(199.4, 1000)).toBe(200)
    expect(clampHeight(450.7, 1000)).toBe(451)
    expect(clampHeight(2000, 1000)).toBe(900)
  })

  it('computeDefaultHeight returns ~50% of window height clamped', () => {
    expect(computeDefaultHeight(1000)).toBe(500)
    // 1200 * 0.5 = 600, max = 1200 - 100 = 1100 → 600
    expect(computeDefaultHeight(1200)).toBe(600)
    // 300 * 0.5 = 150, but floor is 200 → 200
    expect(computeDefaultHeight(300)).toBe(200)
  })
})
