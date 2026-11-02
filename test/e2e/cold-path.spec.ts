import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// PLAN-0121 — the editor stack and two overlays were code-split off the renderer
// cold path. This spec proves, against the built bundle, that each deferred
// surface still appears on demand and its trigger is honored on first use:
//
//   CA-01 — opening a request loads the (deferred) request editor.
//   CA-03 — the activity-panel toggle (Ctrl/Cmd+J) opens the (deferred) panel.
//   CA-04 — the command-palette shortcut (Ctrl/Cmd+P) opens the (deferred) palette.
//
// The structural proof that CodeMirror leaves the first-paint graph lives in the
// build audit (`npm run audit:coldpath`); this spec is the end-to-end counterpart.

test.describe('cold-path deferral', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('deferred surfaces appear on first use', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const { window: page } = ctx

    // The auto-opened workspace shows its single request in the tree.
    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 20_000 })

    // CA-01: opening the request loads the deferred editor — its Send button
    // (rendered only by the RequestEditor) appears.
    await requestRow.click()
    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await expect(sendButton).toBeVisible({ timeout: 15_000 })

    // CA-03: the activity-panel toggle loads and opens the deferred panel. The
    // docked host carries a stable testid.
    await page.keyboard.press('Control+j')
    await expect(page.locator('[data-testid="activity-panel-host"]')).toBeVisible({
      timeout: 15_000
    })
    // Close it again so it doesn't overlay the next assertion.
    await page.keyboard.press('Control+j')
    await expect(page.locator('[data-testid="activity-panel-host"]')).toBeHidden({
      timeout: 15_000
    })

    // CA-04: the command-palette shortcut loads and opens the deferred palette —
    // its search input (a unique placeholder, locale forced to en) appears.
    await page.keyboard.press('Control+p')
    await expect(page.getByPlaceholder('Type a command or search files...')).toBeVisible({
      timeout: 15_000
    })
  })
})
