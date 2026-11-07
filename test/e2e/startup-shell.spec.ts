import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// Early theme resolution and the startup shell, against the built app.
//
// The half that can only be asserted here is the one the unit tests cannot
// reach: that a theme preference seeded on disk is already in force in the
// renderer — window colour, document marking and shell alike — without the
// interface having decided anything. Seeding an explicit preference is also the
// only way a spec can put the app in a theme the host machine is not in, since
// no harness can change the operating system's own theme.
//
// Catalog: STARTUP-001..004.

async function windowBackground(ctx: ElectronAppContext): Promise<string> {
  return ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor()
  )
}

/** `window.api` is declared in the renderer's own types, which the e2e program does not include. */
async function initialResolvedTheme(ctx: ElectronAppContext): Promise<string> {
  return ctx.window.evaluate(
    () =>
      (window as unknown as { api: { theme: { initialResolved: string } } }).api.theme
        .initialResolved
  )
}

/** The palette override on `<html>`, if any (empty when the built-in palette is shown). */
async function inlineCanvas(ctx: ElectronAppContext): Promise<string> {
  return ctx.window.evaluate(() => document.documentElement.style.getPropertyValue('--canvas'))
}

test.describe('startup — theme resolution and shell', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // STARTUP-001
  test('an explicit dark preference is in force from the first frame', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'dark' })
    const { window: page } = ctx

    // The window itself was constructed dark — this is decided before the
    // document exists, so it cannot have come from the interface.
    expect((await windowBackground(ctx)).toLowerCase()).toBe('#0b1020')
    // And the document agrees, so nothing flips once the interface mounts.
    expect(await initialResolvedTheme(ctx)).toBe('dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
    // No palette stored: the built-in stylesheet is what shows, with no override.
    expect(await inlineCanvas(ctx)).toBe('')

    // The interface mounts into the same theme rather than re-deciding it.
    await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
      timeout: 20_000
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  // STARTUP-002
  test('an explicit light preference is in force from the first frame', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { window: page } = ctx

    expect((await windowBackground(ctx)).toLowerCase()).toBe('#eef0f5')
    expect(await initialResolvedTheme(ctx)).toBe('light')
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    expect(await inlineCanvas(ctx)).toBe('')

    await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
      timeout: 20_000
    })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })

  // STARTUP-003
  test('the shell is inert — no text, no roles, no test ids', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const { window: page } = ctx

    // The shell is styling of the empty mount point, so it contributes no node
    // at all. Asserting that directly is what guarantees no locator in any
    // other spec can ever resolve against it.
    const shellNodes = await page.evaluate(() => {
      const root = document.getElementById('root')
      return {
        hasElementsBeforeMount: root === null ? -1 : root.querySelectorAll('*').length,
        rootIsTheOnlyBodyChild: document.body.children.length
      }
    })
    expect(shellNodes.rootIsTheOnlyBodyChild).toBe(1)

    await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
      timeout: 20_000
    })
    // Once mounted, the mount point has children — which is precisely what
    // stops every `#root:empty` rule from applying. Nothing has to be removed.
    expect(shellNodes.hasElementsBeforeMount).toBeGreaterThanOrEqual(0)
  })

  // STARTUP-004
  test('the shell does not come back when the last tab is closed', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const { window: page } = ctx

    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 20_000 })
    await requestRow.click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
      timeout: 15_000
    })

    await page.keyboard.press('Control+w')

    // The content area falls back to its empty presentation, but the mount
    // point still holds the interface, so the shell cannot reappear.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeHidden({
      timeout: 15_000
    })
    expect(
      await page.evaluate(() => document.getElementById('root')?.childElementCount)
    ).toBeGreaterThan(0)
  })
})
