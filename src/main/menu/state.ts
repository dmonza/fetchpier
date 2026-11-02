import { INITIAL_MENU_STATE, type FocusedWindowKind, type MenuState } from '../../shared/menu-model'

/**
 * The menu's state, and nothing else.
 *
 * Deliberately **free of any Electron import**: the places that learn these
 * facts are the workspace session handle, the window focus handlers and the
 * window factory, and none of them should acquire a dependency on the menu's
 * rendering just to report one. `controller.ts` subscribes to this module and
 * owns everything Electron-shaped.
 *
 * REQ Application menu coherence on macOS §6.2.
 */

let state: MenuState = { ...INITIAL_MENU_STATE }
let onChange: ((next: MenuState) => void) | null = null

/** The controller registers here; only one subscriber is ever needed. */
export function subscribeMenuState(listener: (next: MenuState) => void): void {
  onChange = listener
}

export function getMenuState(): MenuState {
  return state
}

/** Merge a report into the state; notify only if something actually moved. */
export function patchMenuState(patch: Partial<MenuState>): void {
  let changed = false
  const next: MenuState = { ...state }

  for (const key of Object.keys(patch) as (keyof MenuState)[]) {
    const value = patch[key]
    if (value !== undefined && next[key] !== value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(next as any)[key] = value
      changed = true
    }
  }

  if (!changed) return
  state = next
  onChange?.(state)
}

export function setMenuHasWindow(hasWindow: boolean): void {
  patchMenuState(hasWindow ? { hasWindow: true, focusedWindow: 'main' } : { hasWindow: false })
}

export function setFocusedWindowKind(kind: FocusedWindowKind): void {
  patchMenuState({ focusedWindow: kind })
}

export function setMenuWorkspaceOpen(open: boolean): void {
  patchMenuState({ hasWorkspace: open })
}

/** Force a notify even when the state is unchanged (a language change). */
export function notifyMenuStateUnchanged(): void {
  onChange?.(state)
}
