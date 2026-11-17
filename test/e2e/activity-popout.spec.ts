import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'fs'
import {
  launchApp,
  closeApp,
  workspaceStatePath,
  type ElectronAppContext
} from './helpers/electron-app'

// The detached Activity window against the built app (ISS-0164, ISS-0073): the
// halves the unit suites cannot reach — a row action crossing from the popout
// through main to the owning window, the popout never writing the main
// window's tab session, and the main window's request chips mirrored to the
// popout and toggled from it.
//
// Catalog: ACT-001, ACT-002, ACT-003.

const SESSION_FILE = 'requests/auth/bearer.http'
const RUN_URL = 'https://api.example.com/popout-run'
const OTHER_RUN_URL = 'https://api.example.com/popout-other-run'

async function treeLoaded(page: Page): Promise<void> {
  await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
    timeout: 20_000
  })
}

const SESSION_REQUEST_ID = '4fde6e84-b91c-403e-9a9b-b6a7bdf807dd'

/**
 * Record one run, as a send from the main window would — by default of the
 * session's request.
 */
async function saveRun(
  page: Page,
  run: { id: string; url: string; requestId: string; sourceFile: string } = {
    id: 'e2e-popout-run',
    url: RUN_URL,
    requestId: SESSION_REQUEST_ID,
    sourceFile: SESSION_FILE
  }
): Promise<void> {
  await page.evaluate(async ({ id, url, requestId, sourceFile }) => {
    const api = (window as unknown as { api: { history: { save: (e: unknown) => Promise<void> } } })
      .api
    await api.history.save({
      id,
      timestamp: new Date().toISOString(),
      request: { method: 'GET', url, headers: {} },
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: 'ok',
        timingMs: 1,
        sizeBytes: 2
      },
      sourceFile,
      requestId
    })
  }, run)
}

async function popOut(ctx: ElectronAppContext): Promise<Page> {
  const opened = ctx.app.waitForEvent('window')
  await ctx.window.evaluate(() =>
    (
      window as unknown as { api: { activityPanel: { popout: () => Promise<unknown> } } }
    ).api.activityPanel.popout()
  )
  const popout = await opened
  await popout.waitForLoadState('domcontentloaded')
  return popout
}

test.describe('activity panel — detached window', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // ACT-001
  test("a run opened from the popout opens in the main window's tab bar", async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      workspaceState: {
        schemaVersion: 1,
        activeEnvironmentId: null,
        session: { tabs: [{ kind: 'request', path: SESSION_FILE }], activeTabIndex: 0 }
      }
    })
    const { window: page } = ctx
    await treeLoaded(page)
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(1)
    await saveRun(page)

    const popout = await popOut(ctx)
    const row = popout.getByText(RUN_URL, { exact: true })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click({ button: 'right' })
    await popout.getByRole('menuitem', { name: 'Open', exact: true }).click()

    await expect(tabs).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /GET https:\/\/api\.example\.com/ })).toBeVisible()
  })

  // ACT-002
  test("a session write from the popout leaves the main window's session on disk", async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      workspaceState: {
        schemaVersion: 1,
        activeEnvironmentId: null,
        session: { tabs: [{ kind: 'request', path: SESSION_FILE }], activeTabIndex: 0 }
      }
    })
    const { window: page } = ctx
    await treeLoaded(page)
    await expect(page.getByRole('tab')).toHaveCount(1)

    const popout = await popOut(ctx)
    await popout.evaluate(() =>
      (
        window as unknown as {
          api: { workspaceState: { setSession: (s: unknown) => Promise<void> } }
        }
      ).api.workspaceState.setSession({ tabs: [], activeTabIndex: -1 })
    )

    const workspacePath = ctx.workspace!.path
    await closeApp(ctx, { keepWorkspacePaths: true })
    ctx = null
    try {
      const state = JSON.parse(await fs.readFile(workspaceStatePath(workspacePath), 'utf-8')) as {
        session: { tabs: Array<{ path: string }>; activeTabIndex: number }
      }
      expect(state.session.tabs.map((t) => t.path)).toEqual([SESSION_FILE])
      expect(state.session.activeTabIndex).toBe(0)
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true })
    }
  })

  // ACT-003
  test("the popout shows the main window's request chips and toggles them there", async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      workspaceState: {
        schemaVersion: 1,
        activeEnvironmentId: null,
        session: { tabs: [{ kind: 'request', path: SESSION_FILE }], activeTabIndex: 0 }
      }
    })
    const { window: page } = ctx
    await treeLoaded(page)
    await expect(page.getByRole('tab')).toHaveCount(1)
    await saveRun(page)
    await saveRun(page, {
      id: 'e2e-popout-other-run',
      url: OTHER_RUN_URL,
      requestId: 'e2e-another-request',
      sourceFile: 'requests/other.http'
    })

    const popout = await popOut(ctx)
    const chip = popout.locator('button[aria-pressed]', { hasText: 'auth/bearer' })
    await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 })
    await expect(popout.getByText(RUN_URL, { exact: true })).toBeVisible()
    await expect(popout.getByText(OTHER_RUN_URL, { exact: true })).toHaveCount(0)

    // Unchecked in the popout, toggled by the main window and sent back.
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
    await expect(popout.getByText(OTHER_RUN_URL, { exact: true })).toBeVisible()

    // Docking back keeps the selection made in the popout.
    const closed = popout.waitForEvent('close')
    await popout.getByTitle('Dock back to main window').click()
    await closed
    await expect(page.locator('button[aria-pressed]', { hasText: 'auth/bearer' })).toHaveAttribute(
      'aria-pressed',
      'false',
      { timeout: 20_000 }
    )
  })
})
