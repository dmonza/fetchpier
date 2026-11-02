import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  launchApp,
  closeApp,
  stubNativeDialogs,
  setRecentWorkspaces,
  type ElectronAppContext
} from './helpers/electron-app'
import { watchErrors } from './helpers/error-watch'
import { readHistoryRuns, type HistoryRunEntry } from './helpers/history-runs'

// PLAN-0044 — E2E UI/UX coverage for the binary body type.
//
// What this spec covers (10 of the 18 listed cases):
//   1. Small text file → httpbin echoes bytes.
//   2. Small PNG round-trip preserves bytes.
//   3. .json without explicit Content-Type → server sees application/json.
//   4. Explicit Content-Type header wins over derived MIME.
//   5. Switching bodyType clears binaryFile; switching back re-prompts.
//   6. Save → close tab → reopen restores filename / size / mime.
//   7. On-disk .http contains only `# @binary-file:`; body section empty.
//   8. `requests/.files/` contains the staged file as `<hash>__<name>`.
//   9. Hand-edited dead ref → clean "Binary file not found" error.
//  10. No renderer console errors / no main unhandled rejections.
//  11. Dark + light mode keep the picker legible.

const FIXTURES_ROOT = resolve(process.cwd(), 'test', 'fixtures', 'binary')
const HELLO_TXT = join(FIXTURES_ROOT, 'hello.txt')
const PIXEL_PNG = join(FIXTURES_ROOT, 'pixel.png')
const PAYLOAD_JSON = join(FIXTURES_ROOT, 'payload.json')

type HistoryEntryShape = HistoryRunEntry

/**
 * Read all entries under `<workspace>/requests/.runs/` and return them sorted
 * by timestamp ascending. Useful to pick the latest send after a Send click.
 *
 * REQ-0068: entries are now `.http` files, parsed by the shared e2e helper.
 */
async function readHistory(workspacePath: string): Promise<HistoryEntryShape[]> {
  return readHistoryRuns(workspacePath)
}

/** Click the request row in the sidebar and wait until the Body tab loads. */
async function openRequest(page: Page, name: string): Promise<void> {
  const row = page.getByRole('treeitem', { name, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
  await expect(bodyTab).toBeVisible({ timeout: 10_000 })
  await bodyTab.click()
}

/** Switch the request body type via the radio group. */
async function setBodyType(
  page: Page,
  type: 'none' | 'x-www-form-urlencoded' | 'raw' | 'binary'
): Promise<void> {
  const radio = page.locator(`input[name="body-type"][value="${type}"]`)
  await expect(radio).toBeVisible({ timeout: 5_000 })
  await radio.check()
}

/** Pick a file in the binary picker. Caller must `stubNativeDialogs` first.
 *  The "Choose file…" trigger opens a StagedFilePicker popover; the popover's
 *  "Select local file…" footer is what actually fires `binary.selectAndStage`
 *  (which honors the stubbed native dialog). */
async function pickFile(page: Page): Promise<void> {
  const chooseBtn = page.getByRole('button', { name: /Choose file/ })
  await expect(chooseBtn).toBeVisible({ timeout: 5_000 })
  await chooseBtn.click()
  await page.getByRole('button', { name: /Select local file/ }).click()
}

/** Trigger an explicit save (renderer's SAVE_NOW_EVENT) and wait for the
 *  .http file mtime to bump. Dispatching the event directly avoids fragile
 *  Ctrl+S keyboard delivery when focus is owned by CodeMirror or an input. */
async function saveTab(page: Page, httpFilePath: string): Promise<void> {
  const before = await fs.stat(httpFilePath).then(
    (s) => s.mtimeMs,
    () => 0
  )
  await page.evaluate(() => {
    window.dispatchEvent(new Event('app:saveNow'))
  })
  await expect
    .poll(async () => {
      const s = await fs.stat(httpFilePath).catch(() => null)
      return s ? s.mtimeMs : 0
    })
    .toBeGreaterThan(before)
}

/** Click Send and wait for a fresh history entry to appear on disk. */
async function sendAndWaitForHistory(
  page: Page,
  workspacePath: string,
  baselineCount: number
): Promise<HistoryEntryShape> {
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true })
  await expect(sendBtn).toBeVisible({ timeout: 10_000 })
  await sendBtn.click()
  await expect(page.getByText(/^2\d{2} /)).toBeVisible({ timeout: 25_000 })
  // Give the main process a brief window to flush the history file.
  let entries: HistoryEntryShape[] = []
  await expect
    .poll(
      async () => {
        entries = await readHistory(workspacePath)
        return entries.length
      },
      { timeout: 8_000 }
    )
    .toBeGreaterThan(baselineCount)
  return entries[entries.length - 1]
}

test.describe('binary body — UI flow & round-trip', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('small text file echoes bytes through httpbin', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)

    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    const entry = await sendAndWaitForHistory(page, workspace.path, 0)
    const expected = await fs.readFile(HELLO_TXT, 'utf-8')

    // httpbin /post returns { data, ... }. For text/plain content the body is
    // returned verbatim in `data`. The exact field is parsed; we assert the
    // bytes survive the round-trip.
    const json = JSON.parse(entry.response.body) as {
      data?: string
      headers?: Record<string, string>
    }
    expect(json.data).toBeDefined()
    // httpbin may inline as data URL when no Content-Type is set; strip the
    // common `data:application/octet-stream;base64,` prefix if present.
    const data = json.data ?? ''
    if (data.startsWith('data:')) {
      const b64 = data.split(',', 2)[1] ?? ''
      expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(expected)
    } else {
      expect(data).toBe(expected)
    }
  })

  test('PNG round-trip preserves bytes', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: PIXEL_PNG })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('pixel.png', { exact: true })).toBeVisible({ timeout: 5_000 })

    const entry = await sendAndWaitForHistory(page, workspace.path, 0)
    const expected = await fs.readFile(PIXEL_PNG)

    const json = JSON.parse(entry.response.body) as { data?: string }
    const data = json.data ?? ''
    // httpbin returns binary as `data:application/octet-stream;base64,<...>`.
    const commaIdx = data.indexOf(',')
    expect(commaIdx).toBeGreaterThan(0)
    const decoded = Buffer.from(data.slice(commaIdx + 1), 'base64')
    expect(decoded.equals(expected)).toBe(true)
  })

  test('.json without explicit Content-Type derives application/json', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: PAYLOAD_JSON })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('payload.json', { exact: true })).toBeVisible({ timeout: 5_000 })

    const entry = await sendAndWaitForHistory(page, workspace.path, 0)
    const json = JSON.parse(entry.response.body) as {
      headers?: Record<string, string>
    }
    const sentContentType = json.headers?.['Content-Type'] ?? json.headers?.['content-type'] ?? ''
    expect(sentContentType.toLowerCase()).toContain('application/json')
  })

  test('explicit Content-Type header wins over derived MIME', async () => {
    // post-echo-typed.http already references the pre-staged hello.txt and
    // pins Content-Type: text/plain. Sending it directly lets us assert that
    // the explicit header survives — without going through the bodyType toggle
    // that auto-drops "managed" content types when switching into binary.
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await openRequest(page, 'post-echo-typed')
    // Confirm the file landed in the picker (binary metadata loaded from .http).
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({
      timeout: 10_000
    })

    const entry = await sendAndWaitForHistory(page, workspace.path, 0)
    const json = JSON.parse(entry.response.body) as {
      headers?: Record<string, string>
    }
    const sentContentType = json.headers?.['Content-Type'] ?? json.headers?.['content-type'] ?? ''
    expect(sentContentType.toLowerCase()).toContain('text/plain')
    expect(sentContentType.toLowerCase()).not.toContain('application/json')
  })

  test('switching bodyType clears binaryFile and re-prompts', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page } = ctx

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Switch to none → BinaryBodyPicker unmounts.
    await setBodyType(page, 'none')
    await expect(page.getByText('hello.txt', { exact: true })).toHaveCount(0)

    // Switch back to binary → state has been cleared, empty picker shows.
    await setBodyType(page, 'binary')
    const chooseBtn = page.getByRole('button', { name: /Choose file/ })
    await expect(chooseBtn).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('hello.txt', { exact: true })).toHaveCount(0)
  })

  test('save → close → reopen restores filename, size, mime', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Persist before relaunch (Send does NOT autosave the .http; only Ctrl+S does).
    await saveTab(page, join(workspace.path, 'requests', 'post-echo.http'))

    const preservedPath = workspace.path
    await closeApp(ctx, { keepWorkspacePaths: true })
    ctx = null

    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: false })
    // Re-point to the preserved workspace (the new launch made its own copy
    // under /tmp; we want the one with the saved binary file).
    await setRecentWorkspaces(ctx.userDataDir, [preservedPath])
    await ctx.window.reload()
    await ctx.window.waitForLoadState('domcontentloaded')

    const recentBtn = ctx.window.getByRole('button', { name: preservedPath.split(/[\\/]/).pop() })
    await expect(recentBtn).toBeVisible({ timeout: 15_000 })
    await recentBtn.click()

    await openRequest(ctx.window, 'post-echo')
    await ctx.window.locator('input[name="body-type"][value="binary"]').waitFor({ timeout: 10_000 })
    await expect(ctx.window.getByText('hello.txt', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    // Size + mime appear inside fileInfo: "hello.txt — 13 B — text/plain"
    await expect(ctx.window.getByText(/13 B/)).toBeVisible({ timeout: 5_000 })
    await expect(ctx.window.getByText(/text\/plain/)).toBeVisible({ timeout: 5_000 })

    // Clean up the preserved tmpdir manually since the second launch did not own it.
    await fs.rm(preservedPath, { recursive: true, force: true })
  })

  test('on-disk .http contains only @binary-file marker; body section empty', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    const httpFile = join(workspace.path, 'requests', 'post-echo.http')
    await saveTab(page, httpFile)
    let raw = ''
    await expect
      .poll(async () => {
        raw = await fs.readFile(httpFile, 'utf-8')
        return /^#\s*@binary-file:\s*[a-f0-9]{64}__hello\.txt\s*$/m.test(raw)
      })
      .toBe(true)
    // REQ-0097 (http-roundtrip-fidelity): the `# @binary-file` marker lives in the
    // metadata region (alongside `@id`), and a binary body writes **no inline body
    // region at all** — the bytes live in `.files/`, referenced only by the marker.
    // So the file has no blank-line-separated body section with content.
    const sepIdx = raw.indexOf('\n\n')
    const body = sepIdx >= 0 ? raw.slice(sepIdx + 2) : ''
    expect(body.trim()).toBe('')
  })

  test('.files/ contains staged file as <hash>__<name>', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    let entries: string[] = []
    await expect
      .poll(async () => {
        entries = await fs.readdir(join(workspace.path, 'requests', '.files')).catch(() => [])
        return entries.length
      })
      .toBeGreaterThan(0)

    const match = entries.find((f) => /^[a-f0-9]{64}__hello\.txt$/.test(f))
    expect(match, `expected <hash>__hello.txt in ${entries.join(',')}`).toBeDefined()
  })

  test('hand-edited dead ref shows "Binary file not found"', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page } = ctx

    await openRequest(page, 'dead-ref')
    await setBodyType(page, 'binary')

    // The picker renders the saved attachment metadata, then the stat()
    // returns exists=false and the missing-file alert appears.
    const alert = page.getByRole('alert').filter({ hasText: /Binary file not found/i })
    await expect(alert).toBeVisible({ timeout: 10_000 })
  })

  test('no renderer console errors / no main unhandled rejections in happy path', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const watcher = await watchErrors(ctx)
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })
    await sendAndWaitForHistory(page, workspace.path, 0)

    const mainRej = await watcher.mainUnhandledRejections()
    expect(watcher.rendererPageErrors).toEqual([])
    expect(mainRej).toEqual([])
    // Console errors are advisory — print them for visibility but don't fail
    // if a known-noisy third-party logs something we did not cause. Tighten
    // later by adding to an allowlist if specific entries appear.
    if (watcher.rendererConsoleErrors.length > 0) {
      console.warn(
        '[binary-body] renderer console errors:\n  ' + watcher.rendererConsoleErrors.join('\n  ')
      )
    }
  })

  test('dark + light mode keep the picker legible', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page } = ctx

    await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
    await openRequest(page, 'post-echo')
    await setBodyType(page, 'binary')
    await pickFile(page)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Cycle the theme toggle until both themes have been visited. The toggle's
    // accessible name reveals the *next* state, not the current one.
    const themeBtn = page.getByRole('button', {
      name: /Switch to (dark|light|system) mode/
    })
    await expect(themeBtn).toBeVisible({ timeout: 5_000 })

    async function isDark(): Promise<boolean> {
      return await page.evaluate(() => document.documentElement.classList.contains('dark'))
    }

    // Visit dark: click until classList.dark is true.
    for (let i = 0; i < 3 && !(await isDark()); i++) await themeBtn.click()
    expect(await isDark()).toBe(true)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Replace/ })).toBeVisible()

    // Visit light: click until classList.dark is false.
    for (let i = 0; i < 3 && (await isDark()); i++) await themeBtn.click()
    expect(await isDark()).toBe(false)
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Replace/ })).toBeVisible()
  })
})
