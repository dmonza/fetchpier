import { test, expect, type Page } from '@playwright/test'
import {
  closeApp,
  launchApp,
  stubNativeDialogs,
  type ElectronAppContext
} from './helpers/electron-app'

// Environment editor — secrets auto-save (no Save button).
//
// Plain variables and secrets persist the same way: as soon as the field is
// left. There is no Save button to remember. This spec drives the real UI and
// verifies persistence across closing and reopening the manager:
//   1. Create a secret  → reopen → it is there with its value.
//   2. Edit the secret  → reopen → it reflects the edit (auto-saved on blur).
//   3. Delete it        → reopen → it is gone.

interface SecretsApiShape {
  reveal: (envId: string, name: string) => Promise<string>
}
interface EnvShape {
  id: string
  name: string
  // REQ-0076: unified map — plain string, `enc:` ciphertext, or `null` (needs-value).
  variables: Record<string, string | null>
}
interface EnvironmentApiShape {
  list: () => Promise<EnvShape[]>
}
type WindowWithApi = Window & {
  api: { secrets: SecretsApiShape; environment: EnvironmentApiShape }
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

async function openManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Manage Environments' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function listEnvs(page: Page): Promise<EnvShape[]> {
  return page.evaluate(() => (window as unknown as WindowWithApi).api.environment.list())
}

async function revealValue(page: Page, envId: string, name: string): Promise<string> {
  return page.evaluate(
    ({ envId, name }) => (window as unknown as WindowWithApi).api.secrets.reveal(envId, name),
    { envId, name }
  )
}

test.describe('environment secrets auto-save', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('create, edit and delete a secret persist across reopening the manager', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)

    // ── Create an environment + a plain variable, then make it secret ────────
    await openManager(page)
    const dialog = page.getByRole('dialog')

    await page.getByPlaceholder('Environment name...').fill('dev')
    await page.getByPlaceholder('Environment name...').press('Enter')

    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByPlaceholder('Variable name').fill('TOKEN')
    await page.getByPlaceholder('Value').fill('val-original')

    await dialog.getByRole('button', { name: 'Make secret' }).click()

    // First secret → one-time key dialog: acknowledge it. Scope to the setup dialog:
    // a variable row's Sync checkbox sits behind the modal, so a page-wide
    // getByRole('checkbox') would resolve to the wrong (already-checked) box.
    const setupDialog = page.getByRole('dialog').filter({ hasText: 'Save your workspace key' })
    await setupDialog.getByRole('checkbox').check()
    await setupDialog.getByRole('button', { name: 'Done' }).click()
    // Git-history note before encrypting an existing value → continue.
    const gitNoteDialog = page.getByRole('dialog').filter({ hasText: 'Before encrypting' })
    await gitNoteDialog.getByRole('button', { name: 'Encrypt' }).click()

    // The variable now shows as a secret (masked).
    await expect(dialog.getByText('TOKEN', { exact: true })).toBeVisible({ timeout: 10_000 })
    const envs = await listEnvs(page)
    const envId = envs.find((e) => e.name === 'dev')?.id
    expect(envId).toBeTruthy()

    // Close and reopen — the secret persists with its value (CA: create persists).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await openManager(page)
    await dialog.getByText('dev', { exact: true }).click()
    await expect(dialog.getByText('TOKEN', { exact: true })).toBeVisible({ timeout: 10_000 })
    expect(await revealValue(page, envId as string, 'TOKEN')).toBe('val-original')

    // ── Edit the secret value; it auto-saves on blur (no Save button) ────────
    await dialog.getByRole('button', { name: 'Reveal' }).click()
    const editInput = page.locator('input:focus')
    await editInput.fill('val-edited')
    await page.keyboard.press('Tab') // blur → auto-save
    // Wait for the encrypted write to land (the blur-save is fire-and-forget).
    await expect.poll(() => revealValue(page, envId as string, 'TOKEN')).toBe('val-edited')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await openManager(page)
    await dialog.getByText('dev', { exact: true }).click()
    await expect(dialog.getByText('TOKEN', { exact: true })).toBeVisible({ timeout: 10_000 })
    // Reopened: the edit was persisted automatically.
    expect(await revealValue(page, envId as string, 'TOKEN')).toBe('val-edited')

    // ── Delete the secret directly via trash (REQ-0077) — no make-plain ──────
    // CA-06: make-plain stays a separate affordance on the secret row.
    await expect(dialog.getByRole('button', { name: 'Make plain (decrypt)' })).toBeVisible()

    // CA-01: click the secret-row trash (the only "Remove" affordance present).
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()

    // CA-05: the confirmation states irreversibility, names the variable, and never
    // shows the plaintext value.
    const confirm = page.getByRole('dialog').filter({ hasText: 'Delete secret?' })
    await expect(confirm).toContainText('TOKEN')
    await expect(confirm).toContainText('cannot be recovered')
    await expect(confirm).not.toContainText('val-edited')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await openManager(page)
    await dialog.getByText('dev', { exact: true }).click()
    // Gone from the unified variables map — deleted as ciphertext, never made plain.
    const finalEnvs = await listEnvs(page)
    const dev = finalEnvs.find((e) => e.id === envId)
    expect(dev?.variables.TOKEN).toBeUndefined()
    await expect(dialog.getByText('TOKEN', { exact: true })).toBeHidden()
  })
})
