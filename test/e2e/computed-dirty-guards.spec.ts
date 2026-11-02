import { test, expect, type Page } from '@playwright/test'
import { basename } from 'node:path'

import {
  launchApp,
  closeApp,
  stubNativeDialogs,
  type ElectronAppContext
} from './helpers/electron-app'
import { copyWorkspaceFixture, removeWorkspaceFixture } from './helpers/fixtures'

// REQ-0095 — Computed (non-sticky) modified state + unsaved-edit guards.
//
// Observable surfaces used here:
//   • Modified state → the breadcrumb "Save" button is enabled only while the
//     active tab is modified (`disabled={!activeTab.isDirty}`).
//   • A guard → the shared "Unsaved changes" prompt (UnsavedChangesModal).
//
// Catalog: UI-004 (workspace switch), UI-005 (bulk close), UI-007 (close
// workspace), UI-008 (dot/Save clears on revert), UI-009 (clean open).
//
// NOTE: rename/move of an open request no longer prompts — the tab now FOLLOWS
// the file (REQ open-tab-file-reconciliation, superseding REQ-0095's close).
// The follow behavior is verified in open-tab-reconciliation.spec.ts (FR-*);
// FR-01 here is the regression that the rename guard is gone.

const REQUEST = 'get-httpbin'

// ---------- Helpers ------------------------------------------------------------

function sidebarRow(page: Page) {
  return page.getByRole('treeitem', { name: REQUEST, exact: true })
}
function saveButton(page: Page) {
  return page.getByRole('button', { name: 'Save', exact: true })
}
function guardDialog(page: Page) {
  return page.getByText('Unsaved changes', { exact: true })
}

/** Open the request as a permanent tab and switch to the Body sub-tab. */
async function openRequest(page: Page): Promise<void> {
  const row = sidebarRow(page)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.dblclick()
  const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
  await expect(bodyTab).toBeVisible({ timeout: 10_000 })
  await bodyTab.click()
  await expect(page.locator('input[name="body-type"]').first()).toBeVisible({ timeout: 5_000 })
}

/** Dirty the open tab by switching the body type (a real content change). */
async function dirtyViaBody(page: Page): Promise<void> {
  await page.locator('input[name="body-type"][value="raw"]').check()
  await expect(saveButton(page)).toBeEnabled({ timeout: 5_000 })
}

// ---------- Specs --------------------------------------------------------------

test.describe('REQ-0095 — computed modified state + guards', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('UI-009/UI-008: opens clean, dirties on edit, and clears on revert', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openRequest(page)
    // UI-009: a freshly-opened, untouched request is NOT modified.
    await expect(saveButton(page)).toBeDisabled({ timeout: 5_000 })

    // Dirty it, then revert the body type back to the loaded baseline.
    await dirtyViaBody(page)
    await page.locator('input[name="body-type"][value="none"]').check()

    // UI-008: after the debounced reconcile the tab returns to not-modified.
    await expect(saveButton(page)).toBeDisabled({ timeout: 5_000 })
  })

  test('FR-01: renaming a modified request follows the file (no prompt, edits kept)', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openRequest(page)
    await dirtyViaBody(page)

    // Rename via the sidebar context menu.
    await sidebarRow(page).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const input = page.locator('input:focus')
    await input.fill('renamed-request')
    await input.press('Enter')

    // No guard prompt — the tab follows the rename (REQ-0095's rename guard is gone).
    await expect(guardDialog(page)).toHaveCount(0, { timeout: 3_000 })
    // The tab re-points: its title updates to the new name and the old one is gone.
    await expect(page.getByRole('tab', { name: 'renamed-request' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('tab', { name: REQUEST })).toHaveCount(0)
    // The unsaved edits survive the move — the Save control stays enabled.
    await expect(saveButton(page)).toBeEnabled()
  })

  test('UI-005: Close All with a modified tab prompts; cancel keeps tabs', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openRequest(page)
    await dirtyViaBody(page)

    await page.getByRole('tab', { name: REQUEST }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close all', exact: true }).click()

    await expect(guardDialog(page)).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(guardDialog(page)).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible()
  })

  test('UI-007: closing the workspace with a modified tab prompts; discard leaves no tab', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window
    const wsName = basename(ctx.workspace!.path)

    await openRequest(page)
    await dirtyViaBody(page)

    // Open the workspace dropdown and choose Close workspace.
    await page.getByRole('button', { name: wsName, exact: true }).click()
    await page.getByRole('button', { name: 'Close workspace', exact: true }).click()

    await expect(guardDialog(page)).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Close without saving', exact: true }).click()

    // Workspace closed → no tabs orphaned, back to the no-workspace state.
    await expect(page.getByRole('tab', { name: REQUEST })).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByText('No workspace selected').first()).toBeVisible({ timeout: 5_000 })
  })

  test('FR-07: drag-and-drop move of a modified request follows the file (no prompt)', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openRequest(page)
    await dirtyViaBody(page)

    // Drag the open request onto the `auth` folder (a real move).
    await sidebarRow(page).dragTo(page.getByRole('treeitem', { name: 'auth', exact: true }))

    // No prompt — the tab follows the move (REQ-0095's move guard is gone).
    await expect(guardDialog(page)).toHaveCount(0, { timeout: 3_000 })
    // The tab stays open under the same title, and its unsaved edits survive.
    await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible({ timeout: 5_000 })
    await expect(saveButton(page)).toBeEnabled()
  })

  test('UI-011: Ctrl/Cmd+W on a modified tab prompts (no silent close)', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openRequest(page)
    await dirtyViaBody(page)

    await page.keyboard.press('Control+w')

    await expect(guardDialog(page)).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(guardDialog(page)).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible()
  })

  test('UI-012: menu "Open Workspace" with a modified tab prompts', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    const second = await copyWorkspaceFixture('default')
    try {
      await stubNativeDialogs(ctx, { pickPath: second.path })

      await openRequest(page)
      await dirtyViaBody(page)

      // Fire the native menu action (no real menu bar in the headless run).
      await ctx.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
        // The action vocabulary is the shared menu item id set (REQ menu
        // coherence §5.6) — 'openWorkspace' was the pre-REQ spelling.
        w?.webContents.send('menu:action', 'file.openWorkspace')
      })

      await expect(guardDialog(page)).toBeVisible({ timeout: 5_000 })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(guardDialog(page)).toHaveCount(0, { timeout: 5_000 })
      await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible()
    } finally {
      await removeWorkspaceFixture(second).catch(() => undefined)
    }
  })

  test('UI-004: opening another workspace with a modified tab prompts; cancel stays', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    const second = await copyWorkspaceFixture('default')
    try {
      await stubNativeDialogs(ctx, { pickPath: second.path })

      await openRequest(page)
      await dirtyViaBody(page)

      await page.getByTitle('Open or create workspace').click()

      await expect(guardDialog(page)).toBeVisible({ timeout: 5_000 })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(guardDialog(page)).toHaveCount(0, { timeout: 5_000 })
      // Still on the original workspace: the request tab is still open.
      await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible()
    } finally {
      await removeWorkspaceFixture(second).catch(() => undefined)
    }
  })
})
