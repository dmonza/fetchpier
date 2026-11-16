import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// ISS-0052 — the URL bar re-splits its text on every keystroke, so the text it
// holds while focused must give back the same query parameters. The pure
// functions are proven in src/renderer/lib/http-serializer.test.ts; this spec
// proves the wiring: what the focused bar shows, and what a save writes after an
// edit in it.
//
// Catalog: URLBAR-01.

const REQUEST = 'get-httpbin'
const QUERY =
  'client_id=abc&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fa%3D1%26b%3D2' +
  '&discount=100%25&x=%2541'

test.describe('ISS-0052 — URL-bar edits keep encoded query parameters', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('URLBAR-01: a host edit in the URL bar saves every encoded parameter unchanged', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window
    const file = join(ctx.workspace!.path, 'requests', `${REQUEST}.http`)
    await fs.writeFile(
      file,
      `# @id 0952047a-c14d-4e5c-a080-56bc81642514\nGET https://auth.example.com/authorize?${QUERY}\n`,
      'utf-8'
    )

    const row = page.getByRole('treeitem', { name: REQUEST, exact: true })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.dblclick()
    await expect(page.getByRole('tab', { name: REQUEST })).toBeVisible({ timeout: 10_000 })

    const url = page.getByPlaceholder('Enter URL...')
    // Blurred, the bar shows the decoded display text.
    await expect(url).toHaveValue(
      'https://auth.example.com/authorize?client_id=abc' +
        '&redirect_uri=https://app.example.com/cb?a=1&b=2&discount=100%&x=%41',
      { timeout: 10_000 }
    )

    // Focused, it holds the editable text: the split's syntax characters escaped.
    await url.click()
    const editable =
      'https://auth.example.com/authorize?client_id=abc' +
      '&redirect_uri=https://app.example.com/cb?a=1%26b=2&discount=100%25&x=%2541'
    await expect(url).toHaveValue(editable)

    // The user changes the host in that text.
    await url.fill(editable.replace('auth.example.com', 'auth2.example.com'))
    await page.evaluate(() => window.dispatchEvent(new Event('app:saveNow')))

    await expect
      .poll(() => fs.readFile(file, 'utf-8'), { timeout: 8_000 })
      .toContain(`GET https://auth2.example.com/authorize?${QUERY}\n`)
  })
})
