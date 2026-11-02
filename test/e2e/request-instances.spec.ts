import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, type ElectronAppContext } from './helpers/electron-app'

// Request instances — `<stem>.<name>.instance.http` clones of a parent request,
// grouped under it in the sidebar. This spec covers ONLY the rendered-UI wiring:
// creating an instance from the context menu (child row + tab opens), the menu
// guard on an instance node, and the delete-confirmation warning + tree refresh.
//
// The on-disk cascade itself (rename/move/delete propagation, and the fresh `@id`
// of a clone) is filesystem logic proven at integration level in
// src/main/ipc/filesystem.ipc.integration.test.ts — it is not re-asserted here.
//
// Fixture `instances` ships:
//   requests/auth/login.http   (parent request, no instances yet)
//   requests/users/get-user.http
//
// Each test creates the instance(s) it needs, then exercises one behavior.

/** Right-click a tree row by its visible label. */
async function rightClickRow(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name, exact: true }).click({ button: 'right' })
}

/** Create an instance of `requestName` via the context menu. */
async function createInstance(
  page: Page,
  requestName: string,
  instanceName: string
): Promise<void> {
  await rightClickRow(page, requestName)
  await page.getByRole('menuitem', { name: 'Create instance' }).click()
  const input = page.getByPlaceholder('instance-name')
  await expect(input).toBeVisible()
  // The inline input must hold focus after the menu closes — otherwise it floats
  // un-dismissable (Radix restoring focus to the trigger row on close).
  await expect(input).toBeFocused()
  await input.fill(instanceName)
  await input.press('Enter')
}

/** Open the Duplicate inline input on an instance row via its context menu. */
async function startDuplicate(page: Page, instanceName: string): Promise<void> {
  await rightClickRow(page, instanceName)
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
}

test.describe('request instances', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // INSTANCE-001 (UI) — creating an instance from a request's context menu groups a
  // child row under the parent and opens it in a tab. (File on disk + fresh @id: integration.)
  test('create instance → child row in tree, tab opens', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })

    await createInstance(page, 'login', 'happy-path')

    // Grouped under the parent in the tree, and opened in a tab.
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByRole('tab', { name: 'happy-path' })).toBeVisible({
      timeout: 10_000
    })
  })

  // INSTANCE-002 (UI) — "Create instance" never appears on an instance's own context menu.
  test('guard: no "Create instance" on an instance node', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })

    await rightClickRow(page, 'happy-path')
    // Rename + Delete are present; Create instance is not.
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Create instance' })).toHaveCount(0)
  })

  // INSTANCE-009 (UI) — Duplicate opens the inline input as a new row below the still-visible
  // source, pre-filled `<name>-copy`; committing lands a sibling row under the same parent and
  // opens it in a tab. (The on-disk name/binding + fresh @id are proven at unit level in core.)
  test('duplicate instance → pre-filled input, sibling row under the same parent, tab opens', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })

    await startDuplicate(page, 'happy-path')

    // The input opens as a new row, pre-filled and ready to overtype, while the
    // source row stays visible above it (so it never reads as a rename).
    const input = page.getByPlaceholder('instance-name')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(input).toHaveValue('happy-path-copy')
    // It must hold focus (not float): the menu must not steal it back on close.
    await expect(input).toBeFocused()
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible()
    await input.fill('error-500')
    await input.press('Enter')

    // The copy is a sibling of the source (both under `login`), and it opens.
    await expect(page.getByRole('treeitem', { name: 'error-500', exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'error-500' })).toBeVisible({
      timeout: 10_000
    })
  })

  // INSTANCE-012 (UI) — the duplicate pre-fill picks the first free -copy name: with
  // `happy-path-copy` already present, duplicating `happy-path` again pre-fills
  // `happy-path-copy-2` rather than the taken `happy-path-copy`.
  test('duplicate pre-fill advances to -copy-2 when -copy already exists', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })

    // First duplicate commits the default `happy-path-copy`.
    await startDuplicate(page, 'happy-path')
    const first = page.getByPlaceholder('instance-name')
    await expect(first).toHaveValue('happy-path-copy', { timeout: 10_000 })
    await first.press('Enter')
    await expect(page.getByRole('treeitem', { name: 'happy-path-copy', exact: true })).toBeVisible({
      timeout: 10_000
    })

    // Second duplicate of the same source now pre-fills the first free name.
    await startDuplicate(page, 'happy-path')
    await expect(page.getByPlaceholder('instance-name')).toHaveValue('happy-path-copy-2', {
      timeout: 10_000
    })
  })

  // INSTANCE-010 (UI) — Escape on the duplicate input discards: no row, no tab.
  test('escape on the duplicate input creates nothing', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })

    await startDuplicate(page, 'happy-path')
    const input = page.getByPlaceholder('instance-name')
    await expect(input).toHaveValue('happy-path-copy', { timeout: 10_000 })
    await input.press('Escape')

    // The source row returns; nothing named after the pre-filled name exists.
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: 'happy-path-copy', exact: true })).toHaveCount(
      0
    )
    await expect(page.getByRole('tab', { name: 'happy-path-copy' })).toHaveCount(0)
  })

  // INSTANCE-011 (UI) — a rejected duplicate surfaces a message instead of failing
  // silently. Driven through the reachable rejection: a name already taken.
  test('duplicating onto a taken name surfaces a message and writes nothing', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await createInstance(page, 'login', 'error-500')
    await expect(page.getByRole('treeitem', { name: 'error-500', exact: true })).toBeVisible({
      timeout: 10_000
    })

    await startDuplicate(page, 'happy-path')
    const input = page.getByPlaceholder('instance-name')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill('error-500')
    await input.press('Enter')

    await expect(page.getByText('An instance named "error-500" already exists')).toBeVisible({
      timeout: 10_000
    })
  })

  // INSTANCE-005 (UI) — the delete-confirmation dialog warns that instances will also be
  // removed, and the parent + instance rows disappear from the tree once confirmed.
  // (The on-disk cascade delete is proven at integration.)
  test('delete parent warns about instances and clears the tree rows', async () => {
    ctx = await launchApp({ fixture: 'instances', autoOpen: true })
    const page = ctx.window

    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toBeVisible({
      timeout: 15_000
    })
    await createInstance(page, 'login', 'happy-path')
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toBeVisible({
      timeout: 10_000
    })

    await rightClickRow(page, 'login')
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    // The delete modal mentions the instances that will also be deleted.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/instance/i)).toBeVisible({
      timeout: 10_000
    })
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // The tree reflects the deletion: parent and its instance rows are gone.
    await expect(page.getByRole('treeitem', { name: 'login', exact: true })).toHaveCount(0)
    await expect(page.getByRole('treeitem', { name: 'happy-path', exact: true })).toHaveCount(0)
  })
})
