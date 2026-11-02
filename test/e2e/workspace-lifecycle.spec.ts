import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import {
  closeApp,
  launchApp,
  setRecentWorkspaces,
  stubNativeDialogs,
  type ElectronAppContext
} from './helpers/electron-app'

// REQ-0055 §4.5.1 — Workspace lifecycle
//
// Flow:
//   1. Boot Electron with NO existing workspace (empty recent list, empty path).
//   2. Stub `dialog.showOpenDialog` to return a fresh tmpdir + `showMessageBox`
//      to confirm the "create new workspace" prompt.
//   3. Click the "Open or create workspace" button. The app initialises the
//      tmpdir (creates `.fetchpier/`, `environments/`, `requests/`).
//   4. Click "New Collection", type a name, press Enter. Assert the folder
//      appears in the sidebar and on disk.
//   5. Click "New Request", type a name, press Enter. Assert the request file
//      appears in the sidebar tree AND a tab opens for it.
//   6. Close the app and relaunch against the same `userDataDir`, pointing
//      `last-workspace.json.recent` at the workspace path. Click the recent
//      entry. Assert both the collection and the request are still listed.

test.describe('workspace lifecycle', () => {
  let ctx: ElectronAppContext | null = null
  let preservedWorkspacePath: string | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
    if (preservedWorkspacePath) {
      await fs.rm(preservedWorkspacePath, { recursive: true, force: true })
      preservedWorkspacePath = null
    }
  })

  test('create → add collection → add request → reopen', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const { window: page, freshWorkspacePath } = ctx
    if (!freshWorkspacePath) throw new Error('expected fresh workspace path')

    // ── 1. Stub native dialogs and create the workspace ──────────────────
    await stubNativeDialogs(ctx, { pickPath: freshWorkspacePath, confirm: true })

    const openButton = page.getByRole('button', { name: 'Open or create workspace' })
    await expect(openButton).toBeVisible({ timeout: 15_000 })
    await openButton.click()

    // The sidebar swaps to the collection tree once the workspace activates.
    // The "New Collection" / "New Request" quick-action buttons only render
    // when `workspacePath` is set in the store, so waiting for one of them
    // is a reliable proxy for "workspace is open".
    const newCollectionButton = page.getByRole('button', { name: 'New Collection' }).first()
    await expect(newCollectionButton).toBeVisible({ timeout: 15_000 })

    // On-disk verification: initialise must have created `.fetchpier/`.
    await expect
      .poll(
        async () =>
          fs
            .access(join(freshWorkspacePath, '.fetchpier', 'settings.json'))
            .then(() => true)
            .catch(() => false),
        { timeout: 5_000 }
      )
      .toBe(true)

    // ── 2. Add a collection at the root ──────────────────────────────────
    await newCollectionButton.click()
    const collectionInput = page.getByPlaceholder('New Collection')
    await expect(collectionInput).toBeVisible()
    await collectionInput.fill('phase5-tests')
    await collectionInput.press('Enter')

    // Wait for the folder to appear in the tree (it's rendered as a button
    // because TreeNode wraps the folder row in a button element).
    const collectionRow = page.getByRole('treeitem', { name: 'phase5-tests' })
    await expect(collectionRow).toBeVisible({ timeout: 10_000 })

    await expect
      .poll(async () =>
        fs
          .stat(join(freshWorkspacePath, 'requests', 'phase5-tests'))
          .then((s) => s.isDirectory())
          .catch(() => false)
      )
      .toBe(true)

    // ── 3. Add a request at the root ─────────────────────────────────────
    const newRequestButton = page.getByRole('button', { name: 'New Request' }).first()
    await newRequestButton.click()
    const requestInput = page.getByPlaceholder('new-request')
    await expect(requestInput).toBeVisible()
    await requestInput.fill('ping')
    await requestInput.press('Enter')

    // The sidebar row uses the file basename without the `.http` extension.
    const requestRow = page.getByRole('treeitem', { name: 'ping', exact: true })
    await expect(requestRow).toBeVisible({ timeout: 10_000 })

    await expect
      .poll(async () =>
        fs
          .access(join(freshWorkspacePath, 'requests', 'ping.http'))
          .then(() => true)
          .catch(() => false)
      )
      .toBe(true)

    // ── 4. Close, relaunch, reopen via recent ────────────────────────────
    // Preserve the workspace path so it survives the close, and pin it on
    // the outer scope so afterEach can clean it up regardless of test
    // outcome from here on.
    preservedWorkspacePath = freshWorkspacePath
    await closeApp(ctx, { keepWorkspacePaths: true })
    ctx = null

    // Spin up a second app instance with a fresh userDataDir, then point its
    // recent list at the workspace we kept alive.
    ctx = await launchApp({ freshWorkspace: true })
    const reopenPage = ctx.window
    await setRecentWorkspaces(ctx.userDataDir, [freshWorkspacePath])
    await reopenPage.reload()
    await reopenPage.waitForLoadState('domcontentloaded')

    const recentButton = reopenPage.getByRole('button', { name: basename(freshWorkspacePath) })
    await expect(recentButton).toBeVisible({ timeout: 15_000 })
    await recentButton.click()

    // ── 5. Persistence check ─────────────────────────────────────────────
    await expect(reopenPage.getByRole('treeitem', { name: 'phase5-tests' })).toBeVisible({
      timeout: 10_000
    })
    await expect(reopenPage.getByRole('treeitem', { name: 'ping', exact: true })).toBeVisible({
      timeout: 10_000
    })
  })

  // PLAN-0089: opening a recent that is no longer a workspace (no `.fetchpier/`)
  // must NOT silently recreate it — it shows an error toast and drops the dead
  // entry from the recent list.
  test('recent that is no longer a workspace → error toast + pruned from recents', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const { window: page, freshWorkspacePath } = ctx
    if (!freshWorkspacePath) throw new Error('expected fresh workspace path')

    // The fresh tmpdir exists but was never initialised (no `.fetchpier/`).
    await setRecentWorkspaces(ctx.userDataDir, [freshWorkspacePath])
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    const recentButton = page.getByRole('button', { name: basename(freshWorkspacePath) })
    await expect(recentButton).toBeVisible({ timeout: 15_000 })
    await recentButton.click()

    // An explanatory error toast appears…
    await expect(page.getByText(/not a Fetchpier workspace/i)).toBeVisible({ timeout: 10_000 })
    // …and the dead entry is removed from the recent list.
    await expect(recentButton).toBeHidden({ timeout: 10_000 })
  })
})
