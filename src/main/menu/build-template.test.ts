import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { MENU_ITEM_IDS, INITIAL_MENU_STATE, type MenuState } from '@shared/menu-model'
import { buildMenuTemplate, RENDERER_SERVED_ITEMS } from './build-template'
import { FALLBACK_MENU_LABELS } from './labels'

/**
 * REQ Application menu coherence on macOS §6.1, §6.8, §6.10.
 *
 * The builder is pure: state + labels + a dev flag in, an Electron template out.
 * These assertions are about the *shape* of that template — which items exist,
 * which claim their accelerator from the platform, and which are gated — not
 * about the enablement rule itself, which `shared/menu-model.test.ts` owns.
 */

const READY: MenuState = {
  hasWindow: true,
  rendererReady: true,
  hasWorkspace: true,
  hasAnyTab: true,
  hasActiveTab: true,
  focusedWindow: 'main'
}

function build(
  overrides: { state?: MenuState; isDev?: boolean } = {}
): MenuItemConstructorOptions[] {
  return buildMenuTemplate({
    state: overrides.state ?? READY,
    labels: FALLBACK_MENU_LABELS,
    isDev: overrides.isDev ?? true,
    onAction: vi.fn(),
    onZoom: vi.fn(),
    onToggleDevTools: vi.fn(),
    onCloseFocusedWindow: vi.fn()
  })
}

/** Every item in the tree, flattened depth-first. */
function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of template) {
    out.push(item)
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu))
  }
  return out
}

function byId(template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const found = flatten(template).find((i) => i.id === id)
  if (!found) throw new Error(`no menu item with id "${id}"`)
  return found
}

describe('buildMenuTemplate', () => {
  it('declares every gated item exactly once', () => {
    const items = flatten(build()).filter((i) => typeof i.id === 'string')
    const ids = items.map((i) => i.id)

    expect([...ids].sort()).toEqual([...MENU_ITEM_IDS].sort())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the enablement decision onto every gated item', () => {
    for (const state of [
      READY,
      INITIAL_MENU_STATE,
      { ...READY, focusedWindow: 'popout' as const }
    ]) {
      const template = build({ state })
      for (const id of MENU_ITEM_IDS) {
        if (id === 'view.toggleDevTools') continue
        const item = byId(template, id)
        expect(typeof item.enabled).toBe('boolean')
      }
    }
  })

  // CA-10 regression: the native Close role owned the close shortcut, which is
  // why it closed the window instead of the tab. It must not come back.
  it('has no native close role competing for the close shortcut', () => {
    expect(flatten(build()).some((i) => i.role === 'close')).toBe(false)
  })

  // CA-14 — developer tools exist only in development builds.
  it('omits developer tools from a release build', () => {
    const ids = flatten(build({ isDev: false })).map((i) => i.id)
    expect(ids).not.toContain('view.toggleDevTools')
  })

  it('includes developer tools in a development build', () => {
    const ids = flatten(build({ isDev: true })).map((i) => i.id)
    expect(ids).toContain('view.toggleDevTools')
  })

  // §6.8 — the interface owns the shortcuts it can implement, so those items
  // display the accelerator without registering it with the platform. Items the
  // main process executes must keep a real one, or nothing would fire them.
  it('displays but does not register accelerators for interface-served items', () => {
    const template = build()
    for (const id of RENDERER_SERVED_ITEMS) {
      const item = byId(template, id)
      if (item.accelerator) {
        expect(item.registerAccelerator).toBe(false)
      }
    }
  })

  it('registers real accelerators for the items the main process executes', () => {
    const template = build()
    for (const id of ['view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'file.closeWindow']) {
      const item = byId(template, id)
      expect(item.accelerator).toBeTruthy()
      expect(item.registerAccelerator).not.toBe(false)
    }
  })

  it('routes every interface-served item through the action callback with its own id', () => {
    const onAction = vi.fn()
    const template = buildMenuTemplate({
      state: READY,
      labels: FALLBACK_MENU_LABELS,
      isDev: true,
      onAction,
      onZoom: vi.fn(),
      onToggleDevTools: vi.fn(),
      onCloseFocusedWindow: vi.fn()
    })

    for (const id of RENDERER_SERVED_ITEMS) {
      onAction.mockClear()
      const item = byId(template, id)
      expect(typeof item.click).toBe('function')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(item.click as any)()
      expect(onAction).toHaveBeenCalledWith(id)
    }
  })

  it('takes every visible label from the supplied vocabulary, never a literal', () => {
    const marked = JSON.parse(JSON.stringify(FALLBACK_MENU_LABELS)) as typeof FALLBACK_MENU_LABELS
    const stamp = (o: Record<string, unknown>): void => {
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (typeof v === 'string') o[k] = `«${v}»`
        else if (v && typeof v === 'object') stamp(v as Record<string, unknown>)
      }
    }
    stamp(marked as unknown as Record<string, unknown>)

    const template = buildMenuTemplate({
      state: READY,
      labels: marked,
      isDev: true,
      appName: '«Fetchpier»',
      onAction: vi.fn(),
      onZoom: vi.fn(),
      onToggleDevTools: vi.fn(),
      onCloseFocusedWindow: vi.fn()
    })

    for (const item of flatten(template)) {
      if (item.type === 'separator') continue
      if (item.label === undefined) continue
      expect(item.label.startsWith('«')).toBe(true)
    }
  })

  it('zooms in, out and to the reset factor through the zoom callback', () => {
    const onZoom = vi.fn()
    const template = buildMenuTemplate({
      state: READY,
      labels: FALLBACK_MENU_LABELS,
      isDev: true,
      onAction: vi.fn(),
      onZoom,
      onToggleDevTools: vi.fn(),
      onCloseFocusedWindow: vi.fn()
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(byId(template, 'view.zoomIn').click as any)()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(byId(template, 'view.zoomOut').click as any)()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(byId(template, 'view.resetZoom').click as any)()

    expect(onZoom.mock.calls).toEqual([['in'], ['out'], ['reset']])
  })
})
