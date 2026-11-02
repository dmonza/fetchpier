import { test, expect } from '@playwright/test'
import { closeApp, launchApp, type ElectronAppContext } from './helpers/electron-app'

// REQ-0055 §4.5.2 — Request pipeline
//
// Drives the `default` fixture against `https://httpbin.org` to validate three
// concerns end-to-end:
//   1. Variable resolution: a request whose URL uses `{{baseUrl}}` reaches
//      httpbin and returns 200.
//   2. Pre-request script: `pre-script-sets-var.http` sets a header via
//      `fp.request.headers.set()` and the request still completes 200.
//   3. Post-response script: `post-script-tests-status.http` runs two
//      `fp.test(...)` assertions; the Tests tab shows both as passing.
//
// The `default` fixture carries two environments (`default` and `httpbin`).
// `env:list` returns them in `fs.readdir` order (unsorted) and the renderer
// auto-selects the first, so which env is active on boot is not deterministic.
// We don't rely on that: `beforeAll` selects `httpbin` explicitly via the
// command palette so `{{baseUrl}}` resolution is pinned to a known env (both
// envs happen to share the same `baseUrl`, but the selection makes it explicit
// and keeps the catalog's "with the httpbin environment selected" precondition
// literally true).

test.describe.configure({ mode: 'serial' })

test.describe('request pipeline', () => {
  let ctx: ElectronAppContext | null = null

  test.beforeAll(async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const page = ctx.window

    // Pin the active environment to `httpbin` via the command palette (Ctrl+P).
    // The palette lists each environment as a button labelled by the env name;
    // `exact: 'httpbin'` disambiguates it from the `get-httpbin` file entry.
    await page.keyboard.press('Control+p')
    const paletteInput = page.getByPlaceholder('Type a command or search files...')
    await expect(paletteInput).toBeVisible({ timeout: 15_000 })
    await paletteInput.fill('httpbin')
    await page.getByRole('button', { name: 'httpbin', exact: true }).click()
    await expect(paletteInput).toBeHidden({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('plain GET resolves {{baseUrl}} and returns 200', async () => {
    if (!ctx) throw new Error('ctx not initialized')
    const page = ctx.window

    const requestRow = page.getByRole('treeitem', { name: '01-get', exact: true })
    await expect(requestRow).toBeVisible({ timeout: 15_000 })
    await requestRow.click()

    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await expect(sendButton).toBeVisible({ timeout: 15_000 })
    await sendButton.click()

    await expect(page.getByText('200 OK', { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('pre-request script can mutate the request and the send still succeeds', async () => {
    if (!ctx) throw new Error('ctx not initialized')
    const page = ctx.window

    const requestRow = page.getByRole('treeitem', { name: 'pre-script-sets-var', exact: true })
    await expect(requestRow).toBeVisible({ timeout: 10_000 })
    await requestRow.click()

    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await sendButton.click()

    await expect(page.getByText('200 OK', { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('post-response script runs fp.test assertions visible in the Tests tab', async () => {
    if (!ctx) throw new Error('ctx not initialized')
    const page = ctx.window

    const requestRow = page.getByRole('treeitem', { name: 'post-script-tests-status', exact: true })
    await expect(requestRow).toBeVisible({ timeout: 10_000 })
    await requestRow.click()

    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await sendButton.click()

    await expect(page.getByText('200 OK', { exact: true })).toBeVisible({ timeout: 20_000 })

    // Response sub-tabs are plain <button> elements (not ARIA tabs). Match by
    // accessible name + exact so we don't collide with any other button text.
    const testsTab = page.getByRole('button', { name: 'Tests', exact: true })
    await expect(testsTab).toBeVisible({ timeout: 10_000 })
    await testsTab.click()

    await expect(page.getByText('status is 200', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByText('body has url', { exact: true })).toBeVisible({
      timeout: 10_000
    })
  })
})
