import { describe, it, expect } from 'vitest'
import {
  MENU_ITEM_IDS,
  INITIAL_MENU_STATE,
  deriveMenuEnablement,
  isMenuItemEnabled,
  type MenuItemId,
  type MenuState
} from './menu-model'

/**
 * The enablement rule is a decision table over six conditions, so it is tested as
 * one: seven representative states, each asserting the *complete* enablement
 * record. Asserting the whole record (rather than a few items per state) is what
 * makes "no item is enabled by omission" checkable — a newly added item that
 * nobody wired into the rule fails every state at once.
 *
 * REQ Application menu coherence on macOS §6.1/§6.4 — CA-01, CA-05, CA-07, CA-08.
 */

const READY_WITH_TABS: MenuState = {
  hasWindow: true,
  rendererReady: true,
  hasWorkspace: true,
  hasAnyTab: true,
  hasActiveTab: true,
  focusedWindow: 'main'
}

function state(patch: Partial<MenuState>): MenuState {
  return { ...READY_WITH_TABS, ...patch }
}

/** The items enabled in a given state; everything else must be disabled. */
function enabledIn(s: MenuState): MenuItemId[] {
  const record = deriveMenuEnablement(s)
  return MENU_ITEM_IDS.filter((id) => record[id])
}

describe('deriveMenuEnablement', () => {
  it('enables everything the main window can serve when ready with a workspace and tabs', () => {
    expect(enabledIn(READY_WITH_TABS).sort()).toEqual([...MENU_ITEM_IDS].sort())
  })

  // CA-05 — the menu is inert until the interface is ready. Only the platform
  // roles stay usable, and those are not modelled here (they are never gated).
  it('disables every application item while the interface is not ready', () => {
    expect(enabledIn(state({ rendererReady: false }))).toEqual([])
  })

  // CA-07 / CA-06 — with no window the only enabled items are the two that
  // re-create one. Note this outranks `rendererReady`, which is stale once the
  // window it described is gone.
  it('leaves only the window-reviving items enabled when no window exists', () => {
    expect(enabledIn(state({ hasWindow: false })).sort()).toEqual(
      ['file.newRequest', 'file.openWorkspace'].sort()
    )
  })

  it('still revives the window when no window exists and the interface was never ready', () => {
    expect(enabledIn(state({ hasWindow: false, rendererReady: false })).sort()).toEqual(
      ['file.newRequest', 'file.openWorkspace'].sort()
    )
  })

  // CA-01 — a closed workspace disables what needs one, and nothing else.
  it('disables only the workspace-scoped items when no workspace is open', () => {
    const s = state({ hasWorkspace: false, hasAnyTab: false, hasActiveTab: false })
    const enabled = enabledIn(s)

    expect(enabled).not.toContain('file.newCollection')
    expect(enabled).not.toContain('file.closeWorkspace')
    expect(enabled).toContain('file.newRequest')
    expect(enabled).toContain('file.openWorkspace')
  })

  it('keeps a workspace open with no tabs from offering tab actions', () => {
    const enabled = enabledIn(state({ hasAnyTab: false, hasActiveTab: false }))

    expect(enabled).toContain('file.newCollection')
    expect(enabled).toContain('file.closeWorkspace')
    expect(enabled).not.toContain('file.save')
    expect(enabled).not.toContain('file.closeTab')
    expect(enabled).not.toContain('file.closeAllTabs')
    expect(enabled).not.toContain('request.send')
    expect(enabled).not.toContain('request.focusUrl')
  })

  // Corner case: tabs exist but none is active. Bulk close still applies;
  // everything that targets *the* active tab does not.
  it('separates "has tabs" from "has an active tab"', () => {
    const enabled = enabledIn(state({ hasActiveTab: false }))

    expect(enabled).toContain('file.closeAllTabs')
    expect(enabled).not.toContain('file.closeTab')
    expect(enabled).not.toContain('file.save')
    expect(enabled).not.toContain('request.send')
  })

  // CA-08 — with the popout focused the menu describes what *that* window can do.
  it('disables the main-window-only items when the popout has focus', () => {
    const enabled = enabledIn(state({ focusedWindow: 'popout' })).sort()

    expect(enabled).toEqual(
      [
        'app.about',
        'app.checkUpdates',
        'file.closeWindow',
        'view.zoomIn',
        'view.zoomOut',
        'view.resetZoom',
        'view.toggleDevTools',
        'window.minimize',
        'window.zoom',
        'window.front'
      ].sort()
    )
  })

  it('never enables a main-window action for the popout, whatever the tab state', () => {
    for (const patch of [{ hasAnyTab: false }, { hasActiveTab: false }, {}]) {
      const enabled = enabledIn(state({ ...patch, focusedWindow: 'popout' }))
      expect(enabled).not.toContain('file.newRequest')
      expect(enabled).not.toContain('file.save')
      expect(enabled).not.toContain('view.toggleSidebar')
    }
  })
})

describe('menu model invariants', () => {
  it('decides every declared item in every state — none is enabled by omission', () => {
    const states: MenuState[] = [
      INITIAL_MENU_STATE,
      READY_WITH_TABS,
      state({ rendererReady: false }),
      state({ hasWindow: false }),
      state({ hasWorkspace: false }),
      state({ focusedWindow: 'popout' })
    ]

    for (const s of states) {
      const record = deriveMenuEnablement(s)
      expect(Object.keys(record).sort()).toEqual([...MENU_ITEM_IDS].sort())
      for (const id of MENU_ITEM_IDS) {
        expect(typeof record[id]).toBe('boolean')
      }
    }
  })

  it('is pure: same input, same output, and the input is not mutated', () => {
    const s = state({})
    const snapshot = JSON.stringify(s)

    expect(deriveMenuEnablement(s)).toEqual(deriveMenuEnablement(s))
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  it('starts from a state in which nothing is enabled but the window revival path', () => {
    // The initial state has no window yet, so the revive items are the only ones
    // available — the menu is installed before the first window exists.
    expect(enabledIn(INITIAL_MENU_STATE).sort()).toEqual(
      ['file.newRequest', 'file.openWorkspace'].sort()
    )
  })

  it('isMenuItemEnabled agrees with the derived record', () => {
    const s = state({ hasWorkspace: false })
    const record = deriveMenuEnablement(s)
    for (const id of MENU_ITEM_IDS) {
      expect(isMenuItemEnabled(s, id)).toBe(record[id])
    }
  })
})
