import { test, expect } from '@playwright/test'
import { promises as fs } from 'fs'
import { join } from 'path'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// Colour palettes against the built app — the halves the unit and renderer
// suites cannot reach: a palette in force from the first frame of a real
// window, a platform mode switch, and a second window.
//
// Expected colours are read from the app itself (`appearance.get`, computed by
// the main process) rather than recomputed here, so this program never imports
// the generator.
//
// Catalog: APPEAR-001..004.

type Palettes = { light: Record<string, string> | null; dark: Record<string, string> | null }

const custom = { hue: 150, intensity: 70, surfaceTint: 40, brightness: 70 }

async function windowBackground(ctx: ElectronAppContext): Promise<string> {
  return (
    await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor()
    )
  ).toLowerCase()
}

async function palettesInForce(ctx: ElectronAppContext): Promise<Palettes> {
  return ctx.window.evaluate(async () => {
    const api = (
      window as unknown as { api: { appearance: { get: () => Promise<{ palettes: unknown }> } } }
    ).api
    return (await api.appearance.get()).palettes as Palettes
  })
}

async function inlineCanvas(page: ElectronAppContext['window']): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue('--canvas'))
}

test.describe('appearance — colour palettes', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // APPEAR-001
  test('a saved palette is in force from the first frame after a restart', async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'dark',
      appearancePalettes: {
        schemaVersion: 1,
        light: { selected: 'ocean' },
        dark: { selected: 'custom', custom }
      }
    })
    const { window: page } = ctx
    const { dark } = await palettesInForce(ctx)
    expect(dark).not.toBeNull()
    expect(dark!.canvas).not.toBe('#0b1020')

    // Decided before the document existed: the window's own colour…
    expect(await windowBackground(ctx)).toBe(dark!.canvas)
    // …and the data the preload applied at document start.
    const handed = await page.evaluate(
      () =>
        (
          window as unknown as {
            api: { appearance: { initial: { dark: { canvas: string } | null } } }
          }
        ).api.appearance.initial.dark?.canvas
    )
    expect(handed).toBe(dark!.canvas)
    expect(await inlineCanvas(page)).toBe(dark!.canvas)

    await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
      timeout: 20_000
    })
    expect(await inlineCanvas(page)).toBe(dark!.canvas)
  })

  // APPEAR-002
  test('a preset chosen in Settings without a workspace applies and is saved', async () => {
    ctx = await launchApp({ freshWorkspace: true, theme: 'light' })
    const { window: page } = ctx
    // The global Settings — not "Workspace settings", which needs a workspace.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radio', { name: 'Paper' }).click()

    const file = join(ctx.userDataDir, 'appsettings.json')
    await expect
      .poll(
        async () =>
          JSON.parse(await fs.readFile(file, 'utf-8')).appearancePalettes?.light?.selected,
        {
          timeout: 10_000
        }
      )
      .toBe('paper')
    const { light } = await palettesInForce(ctx)
    await expect.poll(() => inlineCanvas(page)).toBe(light!.canvas)
    expect(await windowBackground(ctx)).toBe(light!.canvas)
  })

  // APPEAR-003
  test('with System, a platform mode switch swaps to the palette chosen for that mode', async () => {
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'light',
      appearancePalettes: {
        schemaVersion: 1,
        light: { selected: 'ocean' },
        dark: { selected: 'forest' }
      }
    })
    const { window: page } = ctx
    const palettes = await palettesInForce(ctx)
    expect(await inlineCanvas(page)).toBe(palettes.light!.canvas)

    // The same signal an operating-system switch raises under a `system`
    // preference: the platform's resolved theme changes and every window follows.
    await ctx.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect.poll(() => inlineCanvas(page)).toBe(palettes.dark!.canvas)
    await expect.poll(() => windowBackground(ctx!)).toBe(palettes.dark!.canvas)

    await ctx.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect.poll(() => inlineCanvas(page)).toBe(palettes.light!.canvas)
  })

  // APPEAR-004
  test('the detached Activity window follows a saved change and reopens with it', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { app, window: page } = ctx
    await expect(page.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
      timeout: 20_000
    })

    const popoutOpened = app.waitForEvent('window')
    await page.evaluate(() =>
      (
        window as unknown as { api: { activityPanel: { popout: () => Promise<unknown> } } }
      ).api.activityPanel.popout()
    )
    const popout = await popoutOpened
    await popout.waitForLoadState('domcontentloaded')
    expect(await inlineCanvas(popout)).toBe('')

    // A saved change, made from the main window.
    await page.evaluate(() =>
      (
        window as unknown as { api: { appearance: { set: (p: unknown) => Promise<unknown> } } }
      ).api.appearance.set({
        schemaVersion: 1,
        light: { selected: 'forest' },
        dark: { selected: 'original' }
      })
    )
    const { light } = await palettesInForce(ctx)
    await expect.poll(() => inlineCanvas(popout)).toBe(light!.canvas)

    // A window opened after the change starts with it from its first frame.
    await popout.close()
    const reopened = app.waitForEvent('window')
    await page.evaluate(() =>
      (
        window as unknown as { api: { activityPanel: { popout: () => Promise<unknown> } } }
      ).api.activityPanel.popout()
    )
    const second = await reopened
    await second.waitForLoadState('domcontentloaded')
    const handed = await second.evaluate(
      () =>
        (
          window as unknown as {
            api: { appearance: { initial: { light: { canvas: string } | null } } }
          }
        ).api.appearance.initial.light?.canvas
    )
    expect(handed).toBe(light!.canvas)
    expect(await inlineCanvas(second)).toBe(light!.canvas)
  })
})
