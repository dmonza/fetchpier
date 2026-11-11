import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, type ElectronAppContext } from './helpers/electron-app'

// Passive security findings — the Security tab as a user meets it (FIND-012..014).
// The canonical Given/When/Then lives in docs/TESTS.md. The pinned HTTP target
// answers every request with a wildcard CORS policy that allows credentials and a
// versioned `Server` banner; the cases switch rules off through the workspace
// settings to shape what fires.

let ctx: ElectronAppContext | null = null

test.afterEach(async () => {
  if (ctx) {
    await closeApp(ctx)
    ctx = null
  }
})

async function sendGet(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: 'get-httpbin', exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('200 OK', { exact: true })).toBeVisible({ timeout: 20_000 })
}

const securityTab = (page: Page) => page.locator('button[data-response-tab="security"]')

test('FIND-012 — a send with findings shows a badge and the grouped list', async () => {
  ctx = await launchApp({
    fixture: 'default',
    autoOpen: true,
    workspaceSettings: {
      version: 1,
      http: { findings: { disabledRules: ['headers.nosniff-missing'] } }
    }
  })
  const page = ctx.window
  await sendGet(page)

  const tab = securityTab(page)
  await expect(tab.locator('svg')).toHaveCount(1)
  // One medium (wildcard CORS with credentials) and one info (version banner):
  // the badge counts the medium only.
  await expect(tab).toHaveText(/Security\s*1$/)
  await tab.click()

  await expect(page.getByText('Security findings', { exact: true })).toBeVisible()
  const groups = page.locator('[data-severity-group]')
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(0)).toHaveAttribute('data-severity-group', 'medium')
  await expect(groups.nth(1)).toHaveAttribute('data-severity-group', 'info')
  const cors = page.locator('[data-finding="headers.cors-wildcard-credentials"]')
  await expect(cors).toContainText('Wildcard CORS with credentials')
  await expect(cors).toContainText('WHATWG Fetch Standard')
  await expect(page.locator('[data-finding="headers.version-disclosure"]')).toContainText(
    'Header: Server'
  )
})

test('FIND-013 — a send with no findings states the rules applied, with no badge', async () => {
  ctx = await launchApp({
    fixture: 'default',
    autoOpen: true,
    workspaceSettings: {
      version: 1,
      http: {
        findings: {
          disabledRules: [
            'headers.cors-wildcard-credentials',
            'headers.version-disclosure',
            'headers.nosniff-missing'
          ]
        }
      }
    }
  })
  const page = ctx.window
  await sendGet(page)

  const tab = securityTab(page)
  await expect(tab).toHaveText(/^Security$/)
  await tab.click()
  await expect(page.getByText(/^No findings from the rules applied \(\d+\)\.$/)).toBeVisible()
  await expect(page.locator('[data-finding]')).toHaveCount(0)
})

test('FIND-014 — findings turned off: the tab says so and opens the workspace settings', async () => {
  ctx = await launchApp({
    fixture: 'default',
    autoOpen: true,
    workspaceSettings: { version: 1, http: { findings: { enabled: false } } }
  })
  const page = ctx.window
  await sendGet(page)

  const tab = securityTab(page)
  await expect(tab).toHaveText(/^Security$/)
  await tab.click()
  await expect(
    page.getByText('Security findings are turned off for this workspace.', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open workspace settings', exact: true }).click()
  await expect(page.getByText('Evaluate findings on every send', { exact: true })).toBeVisible({
    timeout: 10_000
  })
})
