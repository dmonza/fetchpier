import { test, expect, type Page } from '@playwright/test'

import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// REQ Application menu coherence on macOS.
//
// What is verified *here* rather than in a unit test: the wiring. The
// enablement rule itself is a pure decision table covered by
// `src/shared/menu-model.test.ts`, and the shortcut semantics by
// `useKeyboardShortcuts.test.tsx`; these specs prove those decisions actually
// reach the main process and the interface.
//
// Catalog: MENU-001 (workspace released in main), MENU-002 (close shortcut
// falls back to the window), MENU-003 (saving with no workspace asks for one).

const REQUEST = 'get-httpbin'

/** The bridge surface this spec reaches for; `env.d.ts` is not in scope here. */
type WindowWithApi = Window & {
  api: { filesystem: { readTree: () => Promise<unknown> } }
}

function sidebarRow(page: Page) {
  return page.getByRole('treeitem', { name: REQUEST, exact: true })
}

/** The close shortcut, as the platform running the suite spells it. */
const CLOSE = process.platform === 'darwin' ? 'Meta+w' : 'Control+w'
const SAVE = process.platform === 'darwin' ? 'Meta+s' : 'Control+s'

test.describe('REQ menu coherence — workspace release and close semantics', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) await closeApp(ctx).catch(() => undefined)
    ctx = null
  })

  test('MENU-001: closing the workspace releases it in the main process', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await expect(sidebarRow(page)).toBeVisible({ timeout: 15_000 })

    // Before: a workspace-scoped operation succeeds.
    const before = await page.evaluate(async () => {
      try {
        await (window as unknown as WindowWithApi).api.filesystem.readTree()
        return 'ok'
      } catch (err) {
        return String(err)
      }
    })
    expect(before).toBe('ok')

    // Close it through the same path the native menu item uses.
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
      w?.webContents.send('menu:action', 'file.closeWorkspace')
    })

    // After: the same operation fails, because the session handle is gone.
    // Before this REQ it kept succeeding against the closed folder.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            try {
              await (window as unknown as WindowWithApi).api.filesystem.readTree()
              return 'ok'
            } catch (err) {
              return String(err)
            }
          }),
        { timeout: 10_000 }
      )
      .toContain('No active workspace')
  })

  test('MENU-002: the close shortcut closes the tab, then the window', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    const row = sidebarRow(page)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.dblclick()
    const tab = page.getByRole('tab', { name: REQUEST })
    await expect(tab).toBeVisible({ timeout: 10_000 })

    // First press: the tab goes, the window stays.
    await page.keyboard.press(CLOSE)
    await expect(tab).toHaveCount(0, { timeout: 5_000 })
    expect(ctx.app.windows().length).toBeGreaterThan(0)

    // Second press with nothing left to close: the window goes. This is the
    // fallback that keeps the shortcut from being inert (REQ §6.8).
    //
    // The press itself races the teardown it causes — the page can be gone
    // before the call returns — so the outcome is asserted on the window count,
    // not on the call resolving.
    await page.keyboard.press(CLOSE).catch(() => undefined)
    await expect.poll(() => ctx!.app.windows().length, { timeout: 15_000 }).toBe(0)
    ctx = null
  })
})

test.describe('REQ menu coherence — saving without a workspace', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) await closeApp(ctx).catch(() => undefined)
    ctx = null
  })

  test('MENU-003: saving an untitled request with no workspace asks for one', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window

    // Wait for the no-workspace state to be on screen — the interface has to be
    // listening before a menu action can reach it.
    await expect(page.getByRole('button', { name: 'Open or create workspace' })).toBeVisible({
      timeout: 15_000
    })

    // A request can be composed before a workspace exists (REQ §6.1).
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
      w?.webContents.send('menu:action', 'file.newRequest')
    })
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 10_000 })
    // The editor is code-split off the cold path; its save listener only exists
    // once the chunk has rendered, so wait for the editor itself, not the tab.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
      timeout: 15_000
    })

    // Saving it used to do nothing at all; now it leads somewhere (REQ §6.11).
    await page.keyboard.press(SAVE)

    await expect(page.getByText('A workspace is needed to save', { exact: true })).toBeVisible({
      timeout: 10_000
    })

    // Cancelling leaves the request open and unsaved rather than discarding it.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('tab').first()).toBeVisible()
  })
})
