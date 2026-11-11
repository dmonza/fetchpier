import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, type ElectronAppContext } from './helpers/electron-app'

// Per-request settings overrides applied to a desktop send (PIPE-007). The
// canonical Given/When/Then lives in docs/TESTS.md. The fixture's workspace
// keeps every default (redirects followed, cookie jar on), so only the
// request's own override can produce what each case expects.

let ctx: ElectronAppContext | null = null

test.afterEach(async () => {
  if (ctx) {
    await closeApp(ctx)
    ctx = null
  }
})

async function send(page: Page, request: string): Promise<void> {
  const row = page.getByRole('treeitem', { name: request, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

const responseBody = (page: Page) => page.locator('.cm-content:visible')

test('PIPE-007 — a "follow redirects" override off returns the redirect itself', async () => {
  ctx = await launchApp({ fixture: 'default', autoOpen: true })
  const page = ctx.window
  await send(page, '301-moved')
  await expect(page.getByText(/^301(\s|$)/)).toBeVisible({ timeout: 20_000 })
})

test('PIPE-007 — a "disable cookie jar" override sends no stored cookie', async () => {
  ctx = await launchApp({ fixture: 'default', autoOpen: true })
  const page = ctx.window

  // The jar is on for this request: the cookie the server sets is stored and
  // sent back on the redirect it answers with.
  await send(page, '01-set-cookie')
  await expect(responseBody(page)).toContainText('"session": "fetchpier-test"', {
    timeout: 20_000
  })

  await send(page, '03-read-cookies-jar-off')
  await expect(responseBody(page)).toContainText('"cookies": {}', { timeout: 20_000 })
})
