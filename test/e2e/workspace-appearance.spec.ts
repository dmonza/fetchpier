import { test, expect } from '@playwright/test'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import {
  launchApp,
  closeApp,
  seedWorkspaceState,
  workspaceStatePath,
  type ElectronAppContext
} from './helpers/electron-app'
import {
  copyWorkspaceFixture,
  removeWorkspaceFixture,
  type CopiedWorkspace
} from './helpers/fixtures'

// Workspace colour palettes against the built app — the halves the unit and
// renderer suites cannot reach: a workspace's palette in force from the first
// frame of a restored launch, switching and closing workspaces, a pick in
// Workspace Settings landing in the workspace's personal state (and nowhere
// else), and the detached Activity window following the workspace.
//
// Expected colours are read from the app itself (`appearance.get`, computed by
// the main process), never recomputed here.
//
// Catalog: WSAPPEAR-001..004.

type Tokens = Record<string, string>
type Palettes = { light: Tokens | null; dark: Tokens | null }

const forestDark = {
  schemaVersion: 1,
  appearancePalettes: {
    schemaVersion: 1,
    light: { selected: 'inherit' },
    dark: { selected: 'forest' }
  }
}
const userOceanDark = {
  schemaVersion: 1,
  light: { selected: 'original' },
  dark: { selected: 'ocean' }
}

/** The window-bounds persister's debounce, plus margin for the write to land. */
const WINDOW_STATE_SETTLE_MS = 700

/**
 * Force the app's other writer of `appsettings.json` to run, and wait for it.
 *
 * The main window saves its bounds 400 ms after any move or resize. Left to
 * chance, that lands mid-test only where the window manager settles the window
 * after load, which made this reproducible on CI and invisible elsewhere.
 */
async function forceWindowStateWrite(ctx: ElectronAppContext): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const { width, height } = win.getBounds()
    win.setBounds({ width: width - 20, height: height - 20 })
  })
  await ctx.window.waitForTimeout(WINDOW_STATE_SETTLE_MS)
}

async function appSettingsSansWindowState(file: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
  delete parsed.windowState
  return parsed
}

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

async function darkCanvasInForce(ctx: ElectronAppContext): Promise<string | undefined> {
  return (await palettesInForce(ctx)).dark?.canvas
}

async function inlineCanvas(page: ElectronAppContext['window']): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue('--canvas'))
}

async function treeLoaded(ctx: ElectronAppContext): Promise<void> {
  await expect(ctx.window.getByRole('treeitem', { name: 'get-httpbin' })).toBeVisible({
    timeout: 20_000
  })
}

/** Switch through the sidebar's workspace dropdown, as the user does. */
async function switchTo(ctx: ElectronAppContext, from: string, to: string): Promise<void> {
  await ctx.window.getByRole('button', { name: basename(from), exact: true }).click()
  await ctx.window.getByRole('button', { name: basename(to), exact: true }).click()
  await expect(ctx.window.getByRole('button', { name: basename(to), exact: true })).toBeVisible({
    timeout: 15_000
  })
  await treeLoaded(ctx)
}

async function popout(ctx: ElectronAppContext): Promise<ElectronAppContext['window']> {
  const opened = ctx.app.waitForEvent('window')
  await ctx.window.evaluate(() =>
    (
      window as unknown as { api: { activityPanel: { popout: () => Promise<unknown> } } }
    ).api.activityPanel.popout()
  )
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return page
}

test.describe('appearance — workspace colour palettes', () => {
  let ctx: ElectronAppContext | null = null
  let other: CopiedWorkspace | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
    if (other) {
      await removeWorkspaceFixture(other)
      other = null
    }
  })

  // WSAPPEAR-001 — CA-08
  test("a restored workspace's palette is in force from the first frame", async () => {
    // The user's Dark is the Original, which hands the window no override at
    // all: anything handed at launch can only have come from the workspace.
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'dark',
      workspaceState: forestDark
    })
    const { window: page } = ctx
    const handed = await page.evaluate(
      () =>
        (
          window as unknown as {
            api: { appearance: { initial: { dark: { canvas: string } | null } } }
          }
        ).api.appearance.initial.dark?.canvas
    )
    expect(handed).toBeTruthy()
    // Decided before the document existed: the window's own colour and the
    // data the preload applied at document start.
    expect(await windowBackground(ctx)).toBe(handed)
    expect(await inlineCanvas(page)).toBe(handed)

    await treeLoaded(ctx)
    // Once the workspace is open, the palette in force is the one handed.
    expect(await darkCanvasInForce(ctx)).toBe(handed)
    expect(await inlineCanvas(page)).toBe(handed)
  })

  // WSAPPEAR-002 — CA-10
  test('switching and closing workspaces switch palettes', async () => {
    other = await copyWorkspaceFixture('default')
    await seedWorkspaceState(other.path, forestDark)
    // The launch workspace inherits (no personal state); the other overrides Dark.
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'dark',
      appearancePalettes: userOceanDark,
      extraRecent: [other.path]
    })
    const { window: page } = ctx
    const inheriting = ctx.workspace!.path
    await treeLoaded(ctx)
    const user = await darkCanvasInForce(ctx)
    expect(user).toBeTruthy()
    expect(await inlineCanvas(page)).toBe(user)
    expect(await windowBackground(ctx)).toBe(user)

    await switchTo(ctx, inheriting, other.path)
    await expect.poll(() => darkCanvasInForce(ctx!)).not.toBe(user)
    const forest = await darkCanvasInForce(ctx)
    await expect.poll(() => inlineCanvas(page)).toBe(forest)
    await expect.poll(() => windowBackground(ctx!)).toBe(forest)

    await page.getByRole('button', { name: basename(other.path), exact: true }).click()
    await page.getByRole('button', { name: 'Close workspace', exact: true }).click()
    await expect(page.getByText('No workspace selected').first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => darkCanvasInForce(ctx!)).toBe(user)
    await expect.poll(() => inlineCanvas(page)).toBe(user)
    await expect.poll(() => windowBackground(ctx!)).toBe(user)
  })

  // WSAPPEAR-003 — CA-12
  test('a pick in Workspace Settings applies and is saved to the workspace only', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true, theme: 'light' })
    const { window: page } = ctx
    const ws = ctx.workspace!.path
    await treeLoaded(ctx)

    const appSettingsFile = join(ctx.userDataDir, 'appsettings.json')
    const sharedSettingsFile = join(ws, '.fetchpier', 'settings.json')
    const appSettingsBefore = await appSettingsSansWindowState(appSettingsFile)
    const sharedBefore = await fs.readFile(sharedSettingsFile, 'utf-8')

    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radio', { name: 'Forest' }).click()

    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await fs.readFile(workspaceStatePath(ws), 'utf-8')).appearancePalettes
              ?.light?.selected
          } catch {
            return undefined
          }
        },
        { timeout: 10_000 }
      )
      .toBe('forest')
    const { light } = await palettesInForce(ctx)
    expect(light).not.toBeNull()
    await expect.poll(() => inlineCanvas(page)).toBe(light!.canvas)
    expect(await windowBackground(ctx)).toBe(light!.canvas)

    // Nothing else learnt about it: not the user's settings, not the files the
    // team shares.
    await forceWindowStateWrite(ctx)
    expect(await appSettingsSansWindowState(appSettingsFile)).toEqual(appSettingsBefore)
    expect(await fs.readFile(sharedSettingsFile, 'utf-8')).toBe(sharedBefore)
  })

  // WSAPPEAR-004 — CA-19
  test('the detached Activity window follows the workspace and reopens with it', async () => {
    other = await copyWorkspaceFixture('default')
    // The launch workspace overrides Dark; the other one inherits.
    ctx = await launchApp({
      fixture: 'default',
      autoOpen: true,
      theme: 'dark',
      appearancePalettes: userOceanDark,
      workspaceState: forestDark,
      extraRecent: [other.path]
    })
    const overriding = ctx.workspace!.path
    await treeLoaded(ctx)
    const forest = await darkCanvasInForce(ctx)
    expect(forest).toBeTruthy()

    const detached = await popout(ctx)
    expect(await inlineCanvas(detached)).toBe(forest)

    await switchTo(ctx, overriding, other.path)
    await expect.poll(() => darkCanvasInForce(ctx!)).not.toBe(forest)
    const user = await darkCanvasInForce(ctx)
    await expect.poll(() => inlineCanvas(detached)).toBe(user)

    // A window opened after the switch starts with the palette in force.
    await detached.close()
    const second = await popout(ctx)
    const handed = await second.evaluate(
      () =>
        (
          window as unknown as {
            api: { appearance: { initial: { dark: { canvas: string } | null } } }
          }
        ).api.appearance.initial.dark?.canvas
    )
    expect(handed).toBe(user)
    expect(await inlineCanvas(second)).toBe(user)
  })
})
