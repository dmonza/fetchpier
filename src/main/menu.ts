/**
 * SHIM → `./menu/controller`.
 *
 * The application menu grew from a static template into a small stateful
 * subsystem (REQ Application menu coherence on macOS); it lives in `menu/` now.
 * This file is kept so existing import sites do not churn.
 */
export {
  rebuildMenu,
  patchMenuState,
  getMenuState,
  setMenuWindow,
  setFocusedWindowKind,
  setMenuWorkspaceOpen,
  setMenuWindowFactory,
  setMenuWindowHandlers,
  applyMenuLabels,
  sendMenuAction,
  registerMenuIpc
} from './menu/controller'
