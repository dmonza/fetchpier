import { test, expect, type Locator } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// The settings dialogs against real layout — what no DOM-only suite can
// measure: one fixed box whatever the tab (the title, the tab strip and the
// footer never move), a cap to a small window, and an Appearance tab whose
// cards stay put across its Light / Dark sub-tabs and Customize.
//
// Catalog: SETDLG-001..004.

type Box = { x: number; y: number; width: number; height: number }

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  // Sub-pixel noise is not movement.
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

async function treeLoaded(ctx: ElectronAppContext): Promise<void> {
  await expect(ctx.window.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
    timeout: 20_000
  })
}

/** Select a tab of the dialog and wait until its panel has rendered. */
async function showTab(dialog: Locator, name: string): Promise<void> {
  const tab = dialog.getByRole('tablist').first().getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  // Inactive panels are hidden, so the visible one is the tab just selected.
  await expect(dialog.getByRole('tabpanel').first()).not.toBeEmpty()
  if (name === 'Appearance') {
    await expect(dialog.getByRole('radiogroup', { name: 'Color themes' })).toBeVisible()
  }
}

async function expectStillOnEveryTab(
  dialog: Locator,
  tabs: string[],
  fixed: Locator[]
): Promise<void> {
  await showTab(dialog, tabs[0])
  const first = await Promise.all([dialog, ...fixed].map(box))
  for (const name of tabs.slice(1)) {
    await showTab(dialog, name)
    expect(await Promise.all([dialog, ...fixed].map(box)), `on the ${name} tab`).toEqual(first)
  }
}

test.describe('settings dialogs — fixed size', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // SETDLG-001
  test('Workspace Settings keeps its box, tab strip and footer on every tab', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { window: page } = ctx
    await treeLoaded(ctx)
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expectStillOnEveryTab(
      dialog,
      ['HTTP', 'Certificates', 'Appearance', 'HTTP'],
      [dialog.getByRole('tablist').first(), dialog.getByRole('button', { name: 'Done' })]
    )
  })

  // SETDLG-002
  test('Settings keeps its box and tab strip on every tab', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { window: page } = ctx
    await treeLoaded(ctx)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expectStillOnEveryTab(
      dialog,
      ['General', 'Appearance', 'Proxy', 'Updates', 'Certificates', 'Workspace keys', 'General'],
      [dialog.getByRole('tablist').first()]
    )
  })

  // SETDLG-003
  test('in a small window the dialog fits, Done is reachable and the tab scrolls', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { app, window: page } = ctx
    await treeLoaded(ctx)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(600, 400)
    })
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(400)
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))

    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await showTab(dialog, 'HTTP')
    const frame = await box(dialog)
    expect(frame.y).toBeGreaterThanOrEqual(0)
    expect(frame.x).toBeGreaterThanOrEqual(0)
    expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.h)
    expect(frame.x + frame.width).toBeLessThanOrEqual(viewport.w)

    const done = dialog.getByRole('button', { name: 'Done' })
    await expect(done).toBeInViewport()
    const panel = dialog.getByRole('tabpanel').first()
    expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    // The last setting is reachable by scrolling the panel, not the window.
    await panel.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(dialog.getByRole('button', { name: 'Reset to GitHub defaults' })).toBeInViewport()
    await expect(done).toBeInViewport()
  })

  // SETDLG-004
  test('the Appearance cards stay put across Light / Dark and Customize', async () => {
    // A workspace overriding Dark only: on the Dark sub-tab Settings explains the
    // override, on the Light one it does not — the cards must not move either way.
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'light',
      workspaceState: {
        schemaVersion: 1,
        appearancePalettes: {
          schemaVersion: 1,
          light: { selected: 'inherit' },
          dark: { selected: 'forest' }
        }
      }
    })
    const { window: page } = ctx
    await treeLoaded(ctx)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await showTab(dialog, 'Appearance')
    const cards = dialog.getByRole('radiogroup', { name: 'Color themes' })
    const revert = dialog.getByRole('button', { name: 'Revert changes' })
    const start = await Promise.all([box(cards), box(revert)])

    await dialog.getByRole('tab', { name: 'Dark', exact: true }).click()
    await expect(dialog.getByText(/This workspace uses its own Dark palette/)).toBeVisible()
    expect(await Promise.all([box(cards), box(revert)]), 'on the Dark sub-tab').toEqual(start)

    await dialog.getByRole('tab', { name: 'Light', exact: true }).click()
    await expect(dialog.getByText(/This workspace uses its own Dark palette/)).toBeHidden()
    expect(await Promise.all([box(cards), box(revert)]), 'back on Light').toEqual(start)

    await dialog.getByRole('button', { name: /^Customize / }).click()
    await expect(dialog.getByRole('slider')).toHaveCount(4)
    expect(await Promise.all([box(cards), box(revert)]), 'after Customize').toEqual(start)
  })
})
