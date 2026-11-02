import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { basename, join } from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  launchApp,
  closeApp,
  APP_LAUNCH_PATH,
  APP_VERSION,
  type ElectronAppContext
} from './helpers/electron-app'

// REQ-0064 E2E smoke — UI state per request survives close/reopen and app restart.
//
// We use the default fixture (`get-httpbin.http`, UUID 0952047a-...). Two tests:
//   (a) open request, switch sub-tab to Body, close the tab, reopen from
//       sidebar → expect Body still active.
//   (b) same, but with a full app restart between switch and reopen, against
//       the SAME workspace path on disk.
//
// "Body sub-tab active" is asserted via the body-type radio set which is only
// rendered when the Body sub-tab is selected (BodyEditor.tsx).
//
// Debounce budget: renderer 500 ms + main 200 ms. Wait 1.5 s before close.

const WAIT_FOR_PERSISTENCE_MS = 1500
const SMOKE_REQUEST_ID = '0952047a-c14d-4e5c-a080-56bc81642514'

async function seedRestartUserData(userDataDir: string, workspacePath: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true })
  // last-workspace.json with `path` populated → workspace:getLast auto-opens it.
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify({ path: workspacePath, recent: [workspacePath] }, null, 2),
    'utf-8'
  )
  await fs.writeFile(
    join(userDataDir, 'appsettings.json'),
    JSON.stringify(
      {
        language: 'en',
        zoomFactor: 1,
        // Mark the current version as seen: otherwise the once-per-version
        // About dialog opens over the UI this spec drives.
        lastVersion: APP_VERSION,
        updates: {
          autoCheckEnabled: false,
          intervalDays: 30,
          lastCheckAt: new Date().toISOString()
        }
      },
      null,
      2
    ),
    'utf-8'
  )
}

async function launchAgainstWorkspace(
  workspacePath: string
): Promise<{ app: ElectronApplication; window: Page; userDataDir: string }> {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-uistate-relaunch-'))
  await seedRestartUserData(userDataDir, workspacePath)
  const app = await electron.launch({
    args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window, userDataDir }
}

test.describe('REQ-0064 — per-request UI state persistence', () => {
  let ctx: ElectronAppContext | null = null
  let relaunch: { app: ElectronApplication; userDataDir: string } | null = null
  let preservedWorkspacePath: string | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx, { keepWorkspacePaths: Boolean(preservedWorkspacePath) })
      ctx = null
    }
    if (relaunch) {
      try {
        await relaunch.app.close()
      } catch {
        /* ignore */
      }
      await fs.rm(relaunch.userDataDir, { recursive: true, force: true }).catch(() => undefined)
      relaunch = null
    }
    if (preservedWorkspacePath) {
      await fs.rm(preservedWorkspacePath, { recursive: true, force: true }).catch(() => undefined)
      preservedWorkspacePath = null
    }
  })

  test('Body sub-tab persists across close + reopen within a session', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected default fixture')

    const wsName = basename(workspace.path)
    const recentButton = page.getByRole('button', { name: wsName })
    await expect(recentButton).toBeVisible({ timeout: 15_000 })
    await recentButton.click()

    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 15_000 })
    await requestRow.click()

    // The request-editor tab strip is the only one containing "Params";
    // scope by that to disambiguate from the response viewer's "Body" tab.
    // The request-editor tab strip is rendered above the response viewer in
    // DOM order, so `.first()` reliably picks the request editor's Body button
    // (the response viewer also exposes a Body sub-tab with the same label).
    const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
    await expect(bodyTab).toBeVisible({ timeout: 10_000 })
    await bodyTab.click()
    await expect(page.locator('input[name="body-type"]').first()).toBeVisible({
      timeout: 5_000
    })

    // Wait for the renderer→main debounced write to settle on disk.
    await page.waitForTimeout(WAIT_FOR_PERSISTENCE_MS)

    // Close the active tab via right-click → "Close" context menu. Targeting
    // the in-tab "X" was unreliable in headless Electron (low-opacity button
    // intercepted by neighbour hit targets). The context menu is rendered by
    // shadcn primitives with explicit menuitem roles, which is deterministic.
    // The workspace tab is a div with role="tab" (TabBar.tsx); the sidebar row
    // is role="button" — distinct ARIA roles avoid ambiguity.
    const workspaceTab = page.getByRole('tab', { name: 'get-httpbin' })
    await workspaceTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
    await expect(page.locator('input[name="body-type"]')).toHaveCount(0, { timeout: 5_000 })
    await expect(requestRow).toBeVisible({ timeout: 5_000 })

    // Reopen and assert Body is restored.
    await requestRow.click()
    await expect(page.locator('input[name="body-type"]').first()).toBeVisible({
      timeout: 5_000
    })
  })

  test('Body sub-tab persists across full app restart', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected default fixture')

    const wsName = basename(workspace.path)
    await page.getByRole('button', { name: wsName }).click()
    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 15_000 })
    await requestRow.click()
    // The request-editor tab strip is rendered above the response viewer in
    // DOM order, so `.first()` reliably picks the request editor's Body button
    // (the response viewer also exposes a Body sub-tab with the same label).
    const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
    await expect(bodyTab).toBeVisible({ timeout: 10_000 })
    await bodyTab.click()
    await expect(page.locator('input[name="body-type"]').first()).toBeVisible({
      timeout: 5_000
    })

    await page.waitForTimeout(WAIT_FOR_PERSISTENCE_MS)

    // Verify the persisted file contains the click.
    const uiStateFile = join(workspace.path, 'requests', '.state', 'ui-state.json')
    const map = JSON.parse(await fs.readFile(uiStateFile, 'utf-8')) as Record<
      string,
      { activeReqTab?: string }
    >
    expect(map[SMOKE_REQUEST_ID]?.activeReqTab).toBe('body')

    // Preserve the workspace tmpdir across the first close so the relaunch
    // hits the same `ui-state.json`. The afterEach cleans it up later.
    preservedWorkspacePath = workspace.path
    await closeApp(ctx, { keepWorkspacePaths: true })
    ctx = null

    // Cold relaunch — fresh user-data-dir but pointed at the SAME workspace
    // path. The main process re-reads ui-state.json into its in-memory map,
    // and the renderer's loadAll hydrates the cache before openTab runs.
    relaunch = await launchAgainstWorkspace(preservedWorkspacePath)
    const page2 = relaunch.app.windows()[0]
    await page2.waitForLoadState('domcontentloaded')

    const requestRow2 = page2.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow2).toBeVisible({ timeout: 15_000 })
    await requestRow2.click()
    await expect(page2.locator('input[name="body-type"]').first()).toBeVisible({
      timeout: 10_000
    })
  })
})
