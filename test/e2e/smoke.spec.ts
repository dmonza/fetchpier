import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// REQ-0055 §4.4 smoke test — end-to-end happy path against the built bundle.
//
// Flow:
//   1. Boot Electron with an isolated user-data-dir whose `last-workspace.json`
//      lists the default fixture in `recent` (but NOT in `path` — we want to drive
//      the welcome UI, per the Phase 4 decision).
//   2. Click the recent workspace in the sidebar → app opens it (no native
//      dialog, since the fixture already contains `.fetchpier/`).
//   3. Click the `get-httpbin` request in the collection tree → a tab opens.
//   4. Click Send → undici fetches `https://httpbin.org/get`.
//   5. Assert the status badge shows `200 OK`.
//
// Budget: under 30 s end-to-end, including Electron cold start + the network
// round-trip. Build time (`npm run build`) is NOT inside the budget — the
// helper short-circuits with a clear message if `out/main/index.js` is missing.

test.describe('smoke', () => {
  let ctx: ElectronAppContext | null = null
  let started = 0

  test.beforeAll(() => {
    started = Date.now()
  })

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test.afterAll(() => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    // Visible in the console for tracking the <30 s budget over time.
    console.log(`[smoke] end-to-end elapsed: ${elapsed}s`)
  })

  test('opens workspace, sends request, sees 200 OK', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected default fixture to be copied')

    // The recent button in the sidebar shows the workspace folder's basename.
    // `copyWorkspaceFixture` placed it under a tmpdir we generated, so we know
    // exactly what string to look for — no reliance on translated labels.
    const wsName = basename(workspace.path)

    // 1. Drive the welcome / no-workspace UI: click the recent entry.
    const recentButton = page.getByRole('button', { name: wsName })
    await expect(recentButton).toBeVisible({ timeout: 15_000 })
    await recentButton.click()

    // 2. The collection tree should now show our request. The file name
    //    `get-httpbin.http` is rendered as `get-httpbin` (extension stripped).
    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 15_000 })
    await requestRow.click()

    // 3. The Send button is the canonical action — its localized label
    //    is `Send` because we forced language=en in the helper.
    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await expect(sendButton).toBeVisible({ timeout: 15_000 })
    await sendButton.click()

    // 4. The status badge appears once the response lands. httpbin.org
    //    typically returns 200 within a couple of seconds, but we allow up to
    //    20 s for network jitter (see playwright.config.ts expect.timeout=10s).
    const statusBadge = page.getByText('200 OK', { exact: true })
    await expect(statusBadge).toBeVisible({ timeout: 20_000 })
  })
})
