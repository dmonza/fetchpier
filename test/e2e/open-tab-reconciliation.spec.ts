import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// REQ open-tab-file-reconciliation — open tabs follow their file.
//
// Observable surfaces:
//   • A re-pointed tab → its tab title changes; the old title disappears.
//   • A removed-on-disk tab → its title renders struck-through (`span.line-through`).
//   • A "changed on disk" conflict → the in-editor banner with Reload / Keep.
//   • The on-disk effect of a save → asserted directly against the workspace files.
//
// Catalog: FR-02 (folder move follows), FR-03 (folder delete closes), FR-04
// (external edit reload, clean), FR-05 (external edit conflict, modified), FR-06
// (external removal flag + deliberate re-persist). FR-01 (rename follows) lives in
// computed-dirty-guards.spec.ts next to the guard regressions.

const REQUEST = 'get-httpbin'

function reqPath(ctx: ElectronAppContext, ...segments: string[]): string {
  return join(ctx.workspace!.path, 'requests', ...segments)
}

function tabTitle(page: Page, name: string) {
  return page.getByRole('tab', { name })
}

async function openPermanent(page: Page, name: string): Promise<void> {
  const row = page.getByRole('treeitem', { name, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.dblclick()
  await expect(tabTitle(page, name)).toBeVisible({ timeout: 10_000 })
}

/** Trigger an explicit save of the active tab (the renderer's SAVE_NOW_EVENT). */
async function saveActiveTab(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('app:saveNow')))
}

/** Make the active tab dirty by switching the body type (a real content change). */
async function dirtyViaBody(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Body', exact: true }).first().click()
  await page.locator('input[name="body-type"][value="raw"]').check()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({
    timeout: 5_000
  })
}

test.describe('REQ open-tab-file-reconciliation — tabs follow their file', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('FR-02: a folder move makes the child tab follow; save writes the new path (no duplicate)', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openPermanent(page, 'basic-auth')
    await dirtyViaBody(page)

    // Drag the `auth` folder (containing the open request) into `methods`.
    await page
      .getByRole('treeitem', { name: 'auth', exact: true })
      .dragTo(page.getByRole('treeitem', { name: 'methods', exact: true }))

    // The tab follows — it stays open under its same title, no prompt.
    await expect(tabTitle(page, 'basic-auth')).toBeVisible({ timeout: 10_000 })

    // A deliberate save now writes to the NEW path; the OLD path is never
    // recreated (the stale-tab duplicate this REQ fixes). If the tab had not
    // followed, this save would resurrect the old path.
    await saveActiveTab(page)
    await expect
      .poll(() => existsSync(reqPath(ctx!, 'methods', 'auth', 'basic-auth.http')), {
        timeout: 8_000
      })
      .toBe(true)
    expect(existsSync(reqPath(ctx, 'auth', 'basic-auth.http'))).toBe(false)
  })

  test('FR-03: deleting a folder closes the open tabs of its children', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openPermanent(page, 'basic-auth')

    await page.getByRole('treeitem', { name: 'auth', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // The child tab is closed (previously it was left stale and a save resurrected it).
    await expect(tabTitle(page, 'basic-auth')).toHaveCount(0, { timeout: 10_000 })
    // And the deleted file stays deleted — nothing recreated it.
    expect(existsSync(reqPath(ctx, 'auth', 'basic-auth.http'))).toBe(false)
  })

  test('FR-04: an external edit reloads a clean tab to the new content', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openPermanent(page, REQUEST)
    const url = page.getByPlaceholder('Enter URL...')
    await expect(url).toHaveValue(/\/get/, { timeout: 10_000 })

    // Another tool rewrites the file on disk.
    await fs.writeFile(
      reqPath(ctx, `${REQUEST}.http`),
      '# @id 0952047a-c14d-4e5c-a080-56bc81642514\nGET {{baseUrl}}/anything\nAccept: application/json\n',
      'utf-8'
    )

    // The clean tab adopts the new on-disk content.
    await expect(url).toHaveValue(/\/anything/, { timeout: 10_000 })
  })

  test('FR-05: an external edit flags a conflict on a modified tab (no silent overwrite)', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openPermanent(page, REQUEST)

    // Make an unsaved edit in the tab.
    await page.getByRole('button', { name: 'Body', exact: true }).first().click()
    await page.locator('input[name="body-type"][value="raw"]').check()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({
      timeout: 5_000
    })

    // Another tool edits the same file while the tab is dirty.
    await fs.writeFile(
      reqPath(ctx, `${REQUEST}.http`),
      '# @id 0952047a-c14d-4e5c-a080-56bc81642514\nGET {{baseUrl}}/externally-changed\nAccept: application/json\n',
      'utf-8'
    )

    // The conflict surfaces with reload/keep — the edit is never silently lost.
    await expect(page.getByText('This file changed on disk', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByRole('button', { name: 'Reload from disk', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Keep my edits', exact: true })).toBeVisible()

    // Resolving via Reload adopts the disk version and clears the conflict.
    await page.getByRole('button', { name: 'Reload from disk', exact: true }).click()
    await expect(page.getByText('This file changed on disk', { exact: true })).toHaveCount(0, {
      timeout: 10_000
    })
    await expect(page.getByPlaceholder('Enter URL...')).toHaveValue(/\/externally-changed/)
  })

  test('FR-06: an external removal flags the tab struck-through; a deliberate save re-persists', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    await openPermanent(page, REQUEST)
    await dirtyViaBody(page)

    // Another tool deletes the file.
    await fs.rm(reqPath(ctx, `${REQUEST}.http`))

    // The tab is flagged removed-on-disk: its title renders struck-through.
    await expect(page.locator('span.line-through', { hasText: REQUEST })).toBeVisible({
      timeout: 10_000
    })

    // A deliberate save re-creates the file at its path.
    await saveActiveTab(page)
    await expect
      .poll(() => existsSync(reqPath(ctx!, `${REQUEST}.http`)), { timeout: 8_000 })
      .toBe(true)
  })
})
