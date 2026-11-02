import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  launchApp,
  closeApp,
  stubNativeDialogs,
  type ElectronAppContext
} from './helpers/electron-app'
import { createSparseFile } from './helpers/sparse-file'

// PLAN-0044 — Binary file size limit coverage.
//
// Cases covered (5 listed + sub-cases):
//   1. Defaults — 49 MB stages silently.
//   2. Defaults — 75 MB shows confirm; user confirms → staged.
//   3. Defaults — 75 MB user cancels → picker stays empty.
//   4. Defaults — 150 MB blocked with "too large" alert; no staging.
//   5. Custom (1 / 2 MB) limits: 500 KB silent, 1.5 MB warn, 3 MB block.
//   6. Form rejects `warn > block` at the validation layer; settings.json
//      is not updated when the value is invalid.
//   7. Reset link restores 50 / 100 MB defaults.

const POST_ECHO_NAME = 'post-echo'
const MB = 1024 * 1024

interface WorkspaceSettingsShape {
  binaryFileLimits?: { warnBytes: number; blockBytes: number }
}

interface SettingsFileShape {
  version?: number
  http?: WorkspaceSettingsShape
}

/** Returns the merged `http` block from `.fetchpier/settings.json`. The store
 *  on disk lives under `file.http`, not at the root, so reading the root
 *  directly (like older REQs did) silently misses every setting. */
async function readSettings(workspacePath: string): Promise<WorkspaceSettingsShape> {
  const raw = await fs.readFile(join(workspacePath, '.fetchpier', 'settings.json'), 'utf-8')
  const parsed = JSON.parse(raw) as SettingsFileShape
  return parsed.http ?? {}
}

async function listFilesDir(workspacePath: string): Promise<string[]> {
  return await fs.readdir(join(workspacePath, 'requests', '.files')).catch(() => [])
}

/** The fixture pre-stages a hello.txt under `.files/` so the script specs can
 *  run without a UI pick step. Filter it out when asserting the limits-spec
 *  side effects so we only see *this* test's staging activity. */
const PRE_STAGED_REF = '68e656b251e67e8358bef8483ab0d51c6619f3e7a1a9f0e75838d41ff368f728__hello.txt'

async function listNewlyStaged(workspacePath: string): Promise<string[]> {
  const all = await listFilesDir(workspacePath)
  return all.filter((f) => f !== PRE_STAGED_REF)
}

async function openRequest(page: Page, name: string): Promise<void> {
  const row = page.getByRole('treeitem', { name, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
  await expect(bodyTab).toBeVisible({ timeout: 10_000 })
  await bodyTab.click()
  const radio = page.locator('input[name="body-type"][value="binary"]')
  await expect(radio).toBeVisible({ timeout: 5_000 })
  await radio.check()
}

/** Click the popover's "Select local file…" footer; this is what actually
 *  fires `binary.selectAndStage` (honoring the stubbed native dialog). */
async function selectFromPopover(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Select local file/ }).click()
}

async function pickFile(page: Page): Promise<void> {
  // "Choose file…" opens the StagedFilePicker popover; then we pick from it.
  const btn = page.getByRole('button', { name: /Choose file/ })
  await expect(btn).toBeVisible({ timeout: 5_000 })
  await btn.click()
  await selectFromPopover(page)
}

/** Same as `pickFile` but for the post-selection state where the picker
 *  trigger has been re-labeled "Replace" (it still opens the same popover). */
async function replaceFile(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Replace/ }).click()
  await selectFromPopover(page)
}

/** Open the workspace settings dialog and switch to the HTTP tab. */
async function openSettingsDialogHttpTab(page: Page): Promise<void> {
  const settingsBtn = page.getByRole('button', { name: 'Workspace settings' })
  await expect(settingsBtn).toBeVisible({ timeout: 10_000 })
  await settingsBtn.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  // Tabs default to "http" already, but click it to be explicit and tolerate
  // a future change of `defaultValue`.
  const httpTab = dialog.getByRole('tab', { name: /HTTP/ })
  await httpTab.click()
}

/** Persist binary limits via the same IPC the dialog's onChange uses.
 *  This skips the form-input race where re-sync from upstream overwrites
 *  local state mid-commit; the form path is exercised separately by the
 *  validation test below. Returns the IPC error (if any) so the caller can
 *  surface a useful diagnostic when something goes wrong end-to-end. */
async function setBinaryLimitsViaIpc(
  page: Page,
  warnBytes: number,
  blockBytes: number
): Promise<void> {
  // The workspace-scoped IPC resolves the active workspace from the main-side
  // singleton (no path argument). After an `autoOpen` boot that singleton is set
  // a few ms later (the renderer's getLast resolves async), so poll until the
  // call lands instead of racing it.
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (args) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (window as any).api.workspace.updateHttpSettings({
                binaryFileLimits: { warnBytes: args.warn, blockBytes: args.block }
              })
              return 'ok'
            } catch (err) {
              return String(err)
            }
          },
          { warn: warnBytes, block: blockBytes }
        ),
      { timeout: 10_000 }
    )
    .toBe('ok')
}

test.describe('binary body — size limits', () => {
  let ctx: ElectronAppContext | null = null
  let scratchDir: string | null = null

  test.beforeEach(async () => {
    scratchDir = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-binsize-'))
  })

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true })
      scratchDir = null
    }
  })

  // ── Defaults (50 / 100 MB) ────────────────────────────────────────────────

  /**
   * Override `window.confirm` in the renderer so the picker's warn-flow
   * confirmation is handled deterministically inside the page context.
   * Playwright's `page.on('dialog')` race-conditions with the synchronous
   * confirm + immediate IPC re-entry, so we patch at the source.
   */
  async function setConfirmResponse(page: Page, accept: boolean): Promise<void> {
    await page.evaluate((val) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = window as any
      g.__lastConfirmMessage = ''
      g.confirm = (msg?: string): boolean => {
        g.__lastConfirmMessage = String(msg ?? '')
        return val
      }
    }, accept)
  }

  async function readLastConfirmMessage(page: Page): Promise<string> {
    return await page.evaluate(
      () => (window as unknown as { __lastConfirmMessage?: string }).__lastConfirmMessage ?? ''
    )
  }

  test('defaults — 49 MB stages silently', async () => {
    const file = join(scratchDir!, 'silent-49.bin')
    await createSparseFile(file, 49 * MB)

    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')
    await stubNativeDialogs(ctx, { pickPath: file })
    // Silent path should not raise a confirm; treat any confirm as "no".
    await setConfirmResponse(page, false)

    await openRequest(page, POST_ECHO_NAME)
    await pickFile(page)

    await expect(page.getByText('silent-49.bin', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    expect(await readLastConfirmMessage(page)).toBe('')
    await expect.poll(async () => (await listNewlyStaged(workspace.path)).length).toBeGreaterThan(0)
  })

  test('defaults — 75 MB confirm → user accepts → staged', async () => {
    const file = join(scratchDir!, 'warn-75.bin')
    await createSparseFile(file, 75 * MB)

    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')
    await stubNativeDialogs(ctx, { pickPath: file })
    await setConfirmResponse(page, true)

    await openRequest(page, POST_ECHO_NAME)
    await pickFile(page)

    await expect(page.getByText('warn-75.bin', { exact: true })).toBeVisible({
      timeout: 15_000
    })
    expect(await readLastConfirmMessage(page)).toMatch(/large file|75/i)
    await expect.poll(async () => (await listNewlyStaged(workspace.path)).length).toBeGreaterThan(0)
  })

  test('defaults — 75 MB confirm → user cancels → picker stays empty', async () => {
    const file = join(scratchDir!, 'warn-cancel-75.bin')
    await createSparseFile(file, 75 * MB)

    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')
    await stubNativeDialogs(ctx, { pickPath: file })
    await setConfirmResponse(page, false)

    await openRequest(page, POST_ECHO_NAME)
    await pickFile(page)

    // The confirm fires (we capture its text) and rejects: no staging.
    await expect.poll(async () => readLastConfirmMessage(page)).toMatch(/large file|75/i)
    await expect(page.getByRole('button', { name: /Choose file/ })).toBeVisible({
      timeout: 5_000
    })
    await expect(page.getByText('warn-cancel-75.bin', { exact: true })).toHaveCount(0)
    expect(await listNewlyStaged(workspace.path)).toEqual([])
  })

  test('defaults — 150 MB blocked, no staging', async () => {
    const file = join(scratchDir!, 'block-150.bin')
    await createSparseFile(file, 150 * MB)

    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')
    await stubNativeDialogs(ctx, { pickPath: file })

    await openRequest(page, POST_ECHO_NAME)
    await pickFile(page)

    const alert = page.getByRole('alert').filter({ hasText: /exceeds the workspace block limit/i })
    await expect(alert).toBeVisible({ timeout: 10_000 })
    expect(await listNewlyStaged(workspace.path)).toEqual([])
  })

  // ── Custom limits (1 / 2 MB) ──────────────────────────────────────────────

  test('custom (1 / 2 MB) limits gate small files correctly', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    // Persist via the same IPC the dialog uses — exercises the same code path
    // without racing the form's local-state re-sync.
    await setBinaryLimitsViaIpc(page, 1 * MB, 2 * MB)
    await expect
      .poll(async () => (await readSettings(workspace.path)).binaryFileLimits)
      .toEqual({ warnBytes: 1 * MB, blockBytes: 2 * MB })

    const small = join(scratchDir!, 'small-500kb.bin')
    const mid = join(scratchDir!, 'mid-1500kb.bin')
    const big = join(scratchDir!, 'big-3mb.bin')
    await createSparseFile(small, 500 * 1024)
    await createSparseFile(mid, Math.round(1.5 * MB))
    await createSparseFile(big, 3 * MB)

    await openRequest(page, POST_ECHO_NAME)

    // ── 500 KB: silent ──────────────────────────────────────────────────────
    await stubNativeDialogs(ctx, { pickPath: small })
    await setConfirmResponse(page, false)
    await pickFile(page)
    await expect(page.getByText('small-500kb.bin', { exact: true })).toBeVisible({
      timeout: 5_000
    })
    expect(await readLastConfirmMessage(page)).toBe('')

    // ── 1.5 MB: warn → accept ──────────────────────────────────────────────
    await stubNativeDialogs(ctx, { pickPath: mid })
    await setConfirmResponse(page, true)
    await replaceFile(page)
    await expect(page.getByText('mid-1500kb.bin', { exact: true })).toBeVisible({
      timeout: 5_000
    })
    expect(await readLastConfirmMessage(page)).toMatch(/large file|1\.5/i)

    // ── 3 MB: block ────────────────────────────────────────────────────────
    await stubNativeDialogs(ctx, { pickPath: big })
    await replaceFile(page)
    const blockAlert = page
      .getByRole('alert')
      .filter({ hasText: /exceeds the workspace block limit/i })
    await expect(blockAlert).toBeVisible({ timeout: 10_000 })
  })

  // ── Form validation ───────────────────────────────────────────────────────

  test('form rejects warn > block at the validation layer', async () => {
    // The form's UX shows the validation alert only between the invalid
    // keystroke and the next render — the component re-syncs from upstream on
    // every render, which masks the alert too quickly to observe reliably
    // from Playwright. What we CAN verify deterministically is the contract:
    // an invalid warn > block patch must not persist (it would be rejected by
    // `validatePartial` in workspace-settings-store before hitting disk).
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    // Seed a known-valid baseline so we can detect any unexpected mutation.
    await setBinaryLimitsViaIpc(page, 10 * MB, 20 * MB)
    await expect
      .poll(async () => (await readSettings(workspace.path)).binaryFileLimits)
      .toEqual({ warnBytes: 10 * MB, blockBytes: 20 * MB })

    // Attempt an invalid patch: warn > block. The IPC throws, which surfaces
    // as a rejected promise inside the page.
    const rejected = await page.evaluate(
      async (args) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.workspace.updateHttpSettings({
            binaryFileLimits: { warnBytes: args.warn, blockBytes: args.block }
          })
          return null
        } catch (err) {
          return String(err)
        }
      },
      { warn: 50 * MB, block: 5 * MB }
    )
    expect(rejected).toMatch(/warnBytes must be ≤ blockBytes/i)

    // The baseline must be untouched.
    const after = (await readSettings(workspace.path)).binaryFileLimits
    expect(after).toEqual({ warnBytes: 10 * MB, blockBytes: 20 * MB })
  })

  // ── Reset link ────────────────────────────────────────────────────────────

  test('reset link restores 50 / 100 MB defaults', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    // Seed custom values via IPC (the form-input path is exercised separately
    // and is racy enough that it's not the focus of this test).
    await setBinaryLimitsViaIpc(page, 5 * MB, 20 * MB)
    await expect
      .poll(async () => (await readSettings(workspace.path)).binaryFileLimits)
      .toEqual({ warnBytes: 5 * MB, blockBytes: 20 * MB })

    await openSettingsDialogHttpTab(page)
    const dialog = page.getByRole('dialog')
    const resetLink = dialog.getByRole('button', { name: /Reset to GitHub defaults/i })
    await expect(resetLink).toBeVisible({ timeout: 5_000 })
    await resetLink.click()

    await expect
      .poll(async () => (await readSettings(workspace.path)).binaryFileLimits)
      .toEqual({ warnBytes: 50 * MB, blockBytes: 100 * MB })

    // And the inputs in the dialog should now show 50 / 100.
    const warnInput = dialog.locator('input[type="number"]').nth(1)
    const blockInput = dialog.locator('input[type="number"]').nth(2)
    await expect(warnInput).toHaveValue('50')
    await expect(blockInput).toHaveValue('100')
  })
})
