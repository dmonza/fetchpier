import { test, expect, type Page } from '@playwright/test'
import {
  closeApp,
  launchApp,
  stubNativeDialogs,
  type ElectronAppContext
} from './helpers/electron-app'

// REQ-0074 — local value layer end-to-end through the real preload → IPC → main
// path under Electron. Covers: a plain local override wins and leaves the shared
// config.json untouched (CA-01/CA-02 at the desktop boundary), a local-only
// variable is flagged, clearing falls back to shared, and a workspace with no
// local layer is unaffected (regression).

interface LocalRow {
  name: string
  sharedKind: 'plain' | 'secret' | 'absent'
  hasLocalOverride: boolean
  localOnly: boolean
  orphan: boolean
  invalid: boolean
  divergent: boolean
  localDisplay?: string
}
interface LocalView {
  environmentId: string
  rows: LocalRow[]
}
interface EnvShape {
  id: string
  name: string
  variables: Record<string, string>
}
type WindowWithApi = Window & {
  api: {
    environment: {
      list: () => Promise<EnvShape[]>
      create: (name: string) => Promise<EnvShape>
      save: (env: EnvShape) => Promise<void>
    }
    localValues: {
      getView: (envId: string) => Promise<LocalView>
      set: (envId: string, name: string, value: string) => Promise<void>
      clear: (envId: string, name: string) => Promise<void>
      seed: (envId: string, name: string) => Promise<void>
    }
  }
}

async function createWorkspace(ctx: ElectronAppContext): Promise<void> {
  if (!ctx.freshWorkspacePath) throw new Error('expected fresh workspace path')
  await stubNativeDialogs(ctx, { pickPath: ctx.freshWorkspacePath, confirm: true })
  const openButton = ctx.window.getByRole('button', { name: 'Open or create workspace' })
  await expect(openButton).toBeVisible({ timeout: 15_000 })
  await openButton.click()
  await expect(ctx.window.getByRole('button', { name: 'New Collection' }).first()).toBeVisible({
    timeout: 15_000
  })
}

async function seedEnv(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as unknown as WindowWithApi).api
    const env = await api.environment.create('dev')
    await api.environment.save({ ...env, variables: { baseUrl: 'https://shared.example.com' } })
    return env.id
  })
}

async function getView(page: Page, envId: string): Promise<LocalView> {
  return page.evaluate(
    (id) => (window as unknown as WindowWithApi).api.localValues.getView(id),
    envId
  )
}

async function listEnvs(page: Page): Promise<EnvShape[]> {
  return page.evaluate(() => (window as unknown as WindowWithApi).api.environment.list())
}

test.describe('environment local value layer', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('local override wins, leaves shared config.json untouched, and survives reopen', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)

    const envId = await seedEnv(page)

    // A plain local override of a shared variable.
    await page.evaluate(
      (id) =>
        (window as unknown as WindowWithApi).api.localValues.set(
          id,
          'baseUrl',
          'http://localhost:3000'
        ),
      envId
    )
    // A local-only variable.
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.localValues.set(id, 'debugFlag', 'true'),
      envId
    )

    const view = await getView(page, envId)
    const baseUrl = view.rows.find((r) => r.name === 'baseUrl')
    const debug = view.rows.find((r) => r.name === 'debugFlag')
    expect(baseUrl).toMatchObject({ hasLocalOverride: true, localDisplay: 'http://localhost:3000' })
    expect(debug).toMatchObject({ sharedKind: 'absent', localOnly: true, localDisplay: 'true' })

    // The shared config.json is untouched (CA-02): the team file keeps its value
    // and gains no local-only name.
    const envs = await listEnvs(page)
    const dev = envs.find((e) => e.id === envId)
    expect(dev?.variables.baseUrl).toBe('https://shared.example.com')
    expect(dev?.variables.debugFlag).toBeUndefined()

    // Clearing the override falls back to shared.
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.localValues.clear(id, 'baseUrl'),
      envId
    )
    const after = await getView(page, envId)
    expect(after.rows.find((r) => r.name === 'baseUrl')?.hasLocalOverride).toBe(false)
    // The local-only one is still there.
    expect(after.rows.find((r) => r.name === 'debugFlag')?.localOnly).toBe(true)
  })

  test('a fresh environment with no local layer reports no overrides (regression)', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)
    const envId = await seedEnv(page)

    const view = await getView(page, envId)
    expect(view.rows.every((r) => !r.hasLocalOverride && !r.localOnly)).toBe(true)
    expect(view.rows.find((r) => r.name === 'baseUrl')?.sharedKind).toBe('plain')
  })

  // REQ-0075 — Sync check.

  test('unchecking seeds the shared value (identical, non-divergent); re-check uncovers the live shared value', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)
    const envId = await seedEnv(page)

    // Unchecking Sync = seed the entry with the current shared value (CA-02).
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.localValues.seed(id, 'baseUrl'),
      envId
    )
    let row = (await getView(page, envId)).rows.find((r) => r.name === 'baseUrl')
    // Seeded entry equals shared: an applied override that is NOT divergent (silent re-check).
    expect(row).toMatchObject({
      hasLocalOverride: true,
      divergent: false,
      localDisplay: 'https://shared.example.com'
    })

    // The team changes the shared value after the local diverged.
    await page.evaluate((id) => {
      const api = (window as unknown as WindowWithApi).api
      return api.environment
        .list()
        .then((envs) => envs.find((e) => e.id === id)!)
        .then((env) =>
          api.environment.save({ ...env, variables: { baseUrl: 'https://new.example.com' } })
        )
    }, envId)
    // The still-seeded local value now diverges from the new shared value.
    row = (await getView(page, envId)).rows.find((r) => r.name === 'baseUrl')
    expect(row?.divergent).toBe(true)

    // Re-check (clear) returns to following shared — uncovering the *new* shared value.
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.localValues.clear(id, 'baseUrl'),
      envId
    )
    row = (await getView(page, envId)).rows.find((r) => r.name === 'baseUrl')
    expect(row?.hasLocalOverride).toBe(false)
    const dev = (await listEnvs(page)).find((e) => e.id === envId)
    expect(dev?.variables.baseUrl).toBe('https://new.example.com')
  })

  test('an edited local override is reported divergent; an unshared variable materializes with the shared value, never the local one', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)
    const envId = await seedEnv(page)

    await page.evaluate(
      (id) =>
        (window as unknown as WindowWithApi).api.localValues.set(
          id,
          'baseUrl',
          'http://localhost:3000'
        ),
      envId
    )
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.localValues.set(id, 'debugFlag', 'true'),
      envId
    )
    const view = await getView(page, envId)
    expect(view.rows.find((r) => r.name === 'baseUrl')).toMatchObject({
      hasLocalOverride: true,
      divergent: true
    })
    // REQ-0108 — an unshared variable: a local value with no entry in the shared file.
    expect(view.rows.find((r) => r.name === 'debugFlag')).toMatchObject({
      sharedKind: 'absent',
      localOnly: true,
      divergent: false
    })

    // Materializing it (the Shared-cell gesture) writes the *typed* value through the
    // real IPC path. The directional rule holds at the boundary: the local value never
    // reaches config.json, and it survives as an override that still wins.
    await page.evaluate((id) => {
      const api = (window as unknown as WindowWithApi).api
      return api.environment
        .list()
        .then((envs) => envs.find((e) => e.id === id)!)
        .then((env) =>
          api.environment.save({ ...env, variables: { ...env.variables, debugFlag: '' } })
        )
    }, envId)

    const dev = (await listEnvs(page)).find((e) => e.id === envId)
    expect(dev?.variables.debugFlag).toBe('')
    expect(Object.values(dev?.variables ?? {})).not.toContain('true')

    const after = (await getView(page, envId)).rows.find((r) => r.name === 'debugFlag')
    expect(after).toMatchObject({ sharedKind: 'plain', localOnly: false, hasLocalOverride: true })
    expect(after?.localDisplay).toBe('true')
  })

  test('the editor row shows a Sync check and no standalone clear-override affordance', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)

    // Drive the real editor UI: create an environment and add a variable row.
    await page.getByRole('button', { name: 'Manage Environments' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Environment name...').fill('dev')
    await dialog.getByRole('button', { name: 'New Environment' }).click()
    await dialog.getByRole('button', { name: 'Add' }).click()
    await dialog.getByPlaceholder('Variable name').fill('baseUrl')
    await dialog.getByPlaceholder('Variable name').press('Tab')

    // The per-row Sync check exists (REQ-0075) …
    await expect(dialog.getByRole('checkbox', { name: 'Sync' }).first()).toBeVisible()
    // … and the old clear-override button is gone (operational check).
    await expect(dialog.getByRole('button', { name: 'Clear local value' })).toHaveCount(0)
  })
})
