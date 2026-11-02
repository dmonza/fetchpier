import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APP_VERSION, launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// The About dialog announces every version change exactly once, and it takes
// precedence over the interval-based update prompt. `lastVersion` in
// `appsettings.json` is the whole memory: absent or different → show; equal →
// stay quiet and do not rewrite the file.
//
// The copyright line and license body are read from the packaged LICENSE, so
// the dialog can never drift from the file that governs the distribution.

/** The packaged licence, exactly as the dialog must render it. */
const LICENSE_TEXT = readFileSync(resolve(process.cwd(), 'LICENSE'), 'utf-8')
  .replace(/\r\n/g, '\n')
  .trim()
const LICENSE_COPYRIGHT = LICENSE_TEXT.split('\n').find((line) => line.startsWith('Copyright'))!

/** An update check that is long overdue, so the prompt is due on boot. */
const UPDATES_DUE = {
  autoCheckEnabled: true,
  intervalDays: 1,
  lastCheckAt: new Date('2020-01-01T00:00:00Z').toISOString()
}

async function readSettings(userDataDir: string): Promise<{ lastVersion?: string | null }> {
  const raw = await fs.readFile(join(userDataDir, 'appsettings.json'), 'utf-8')
  return JSON.parse(raw) as { lastVersion?: string | null }
}

/**
 * The settings file as the About dialog could ever affect it — i.e. everything
 * except `windowState`.
 *
 * `appsettings.json` has a second, legitimate writer: `create-main-window.ts`
 * persists the window bounds 400 ms after any `resize`/`move`. It writes the
 * whole merged settings document, not just the bounds, so it also materializes
 * any default the seeded file omitted — which is how this assertion once failed
 * on two fields no behavior under test ever touches. The seed is complete now
 * (`helpers/settings-seed.ts`), so the only field that write can still change
 * is the one excluded here.
 */
async function readSettingsSansWindowState(userDataDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(join(userDataDir, 'appsettings.json'), 'utf-8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  delete parsed.windowState
  return parsed
}

/** The window-bounds persister's debounce, plus margin for the write to land. */
const WINDOW_STATE_DEBOUNCE_MS = 400

/**
 * Force the window-bounds writer to run, and wait for it.
 *
 * Left to chance this only happens on a platform whose window manager settles
 * the window after the renderer loads — so the interference it causes was
 * reproducible on CI and invisible on the maintainer's machine. Triggering it
 * deliberately makes the assertion prove the same thing everywhere.
 */
async function forceWindowStateWrite(ctx: ElectronAppContext): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const { width, height } = win.getBounds()
    win.setBounds({ width: width - 20, height: height - 20 })
  })
  await ctx.window.waitForTimeout(WINDOW_STATE_DEBOUNCE_MS + 300)
}

test.describe('About on version change', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('opens on a settings file that predates lastVersion, and stamps it', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, lastVersion: null })
    const { window: page, userDataDir } = ctx

    const about = page.getByRole('dialog', { name: 'About Fetchpier' })
    await expect(about).toBeVisible()

    // The heading is the LICENSE copyright line, verbatim…
    await expect(about.getByText(LICENSE_COPYRIGHT, { exact: true })).toBeVisible()
    // …and the block below it is the whole file, notice included.
    expect(await about.locator('pre').textContent()).toBe(LICENSE_TEXT)

    // Shown ⇒ stamped, without waiting for the dialog to close.
    await expect.poll(async () => (await readSettings(userDataDir)).lastVersion).toBe(APP_VERSION)
  })

  test('opens when the stored version differs from the current one', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, lastVersion: '0.0.1-old' })
    await expect(ctx.window.getByRole('dialog', { name: 'About Fetchpier' })).toBeVisible()
  })

  test('stays closed when the stored version matches, and rewrites nothing', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, lastVersion: APP_VERSION })
    const { window: page, userDataDir } = ctx

    await expect(page.getByRole('dialog', { name: 'About Fetchpier' })).toBeHidden()

    // A manual open on the current version must not touch the settings.
    const before = await readSettingsSansWindowState(userDataDir)

    // Run the unrelated writer in between, on purpose: its interference is the
    // reason this assertion has broken before, and it must not break it again.
    await forceWindowStateWrite(ctx)

    await page.getByRole('button', { name: 'About Fetchpier' }).click()
    await expect(page.getByRole('dialog', { name: 'About Fetchpier' })).toBeVisible()
    await expect(page.getByText(LICENSE_COPYRIGHT, { exact: true })).toBeVisible()
    expect(await readSettingsSansWindowState(userDataDir)).toEqual(before)
    expect((await readSettings(userDataDir)).lastVersion).toBe(APP_VERSION)
  })

  test('wins over a due update prompt, which opens once the About closes', async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      lastVersion: '0.0.1-old',
      updates: UPDATES_DUE
    })
    const { window: page } = ctx

    const about = page.getByRole('dialog', { name: 'About Fetchpier' })
    const updates = page.getByRole('dialog', { name: 'Check for Updates' })

    await expect(about).toBeVisible()
    await expect(updates).toBeHidden()

    await page.keyboard.press('Escape')
    await expect(about).toBeHidden()
    await expect(updates).toBeVisible()
  })

  test('holds the postponed prompt across the third-party-licenses detour', async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      lastVersion: '0.0.1-old',
      updates: UPDATES_DUE
    })
    const { window: page } = ctx

    const about = page.getByRole('dialog', { name: 'About Fetchpier' })
    const thirdParty = page.getByRole('dialog', { name: 'Third-Party Licenses' })
    const updates = page.getByRole('dialog', { name: 'Check for Updates' })

    await expect(about).toBeVisible()
    await about.getByRole('button', { name: 'Third-Party Licenses' }).click()

    await expect(thirdParty).toBeVisible()
    await expect(updates).toBeHidden()

    await page.keyboard.press('Escape')
    await expect(thirdParty).toBeHidden()
    await expect(updates).toBeVisible()
  })

  test('cancels the postponed prompt when the user opens updates from the About', async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      lastVersion: '0.0.1-old',
      updates: UPDATES_DUE
    })
    const { window: page } = ctx

    const about = page.getByRole('dialog', { name: 'About Fetchpier' })
    const updates = page.getByRole('dialog', { name: 'Check for Updates' })

    await expect(about).toBeVisible()
    await about.getByRole('button', { name: 'Check for updates' }).click()

    await expect(about).toBeHidden()
    await expect(updates).toBeVisible()

    // Closing it must not re-open it from the postponed check.
    await page.keyboard.press('Escape')
    await expect(updates).toBeHidden()
    await page.waitForTimeout(300)
    await expect(updates).toBeHidden()
  })
})
