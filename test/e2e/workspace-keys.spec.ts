import { test, expect, _electron, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import {
  closeApp,
  launchApp,
  stubNativeDialogs,
  APP_LAUNCH_PATH,
  type ElectronAppContext
} from './helpers/electron-app'

// REQ-0073 — Workspace keys management surface (general settings → "Workspace
// keys"). These specs drive the real IPC: keys are created through the genuine
// setup/rotate flows, never forged, so the keystore, manifests and reference
// marks all line up with production.
//
// Coverage map:
//   CA-01 list + In-use mark + IPC/store boundary  → "in-use key … refuses to delete" (SEC-008)
//   guarded delete blocks an in-use key (REQ-0096)  → same test, blocked modal + IPC
//   CA-02 delete removes only the local copy        → "not-referenced key … deletes it" (SEC-012)
//   CA-08 browsing never unwraps (no safeStorage)   → same test, decrypt counter
//   CA-03 proactive add happy path                  → "proactive add"
//   CA-04 add rejects bad structure                 → "proactive add"
//   CA-05 identical re-add is a silent no-op        → "proactive add"
//   rotate / clone mark transition (edge case)      → "rotate flips the mark"
//   CA-06 + corrupt-stored replacement (edge case)  → "replace a corrupt key"

async function createWorkspace(ctx: ElectronAppContext): Promise<string> {
  if (!ctx.freshWorkspacePath) throw new Error('expected fresh workspace path')
  await stubNativeDialogs(ctx, { pickPath: ctx.freshWorkspacePath, confirm: true })
  const openButton = ctx.window.getByRole('button', { name: 'Open or create workspace' })
  await expect(openButton).toBeVisible({ timeout: 15_000 })
  await openButton.click()
  await expect(ctx.window.getByRole('button', { name: 'New Collection' }).first()).toBeVisible({
    timeout: 15_000
  })
  return ctx.freshWorkspacePath
}

interface SetupResult {
  key: string
  keyId: string
}

interface SecretsApiShape {
  setup: () => Promise<SetupResult>
  rotate: () => Promise<SetupResult>
  deleteKey: (keyId: string) => Promise<void>
  listKeys: () => Promise<{ entries: Array<Record<string, unknown>> }>
}

type WindowWithApi = Window & { api: { secrets: SecretsApiShape } }

/**
 * Run the genuine setup flow.
 *
 * These specs require the `os-keychain` backend: without an OS keyring the
 * secrets subsystem correctly keeps keys in memory and never writes
 * `keystore.json`, leaving them asserting against a file that
 * was never created. That is a property of the host, so it is checked once in
 * `global-setup.ts` (`FETCHPIER_TEST_REQUIRE_KEYRING`) rather than here — one
 * host fact should produce one message, not five failing specs.
 */
async function setupSecrets(page: Page): Promise<SetupResult> {
  return page.evaluate(() => (window as unknown as WindowWithApi).api.secrets.setup())
}

async function openKeysTab(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:openSettings')))
  await page.getByRole('tab', { name: 'Workspace keys' }).click()
}

test.describe('workspace keys management', () => {
  let ctx: ElectronAppContext | null = null

  // These specs assert against a keystore on disk, which only exists on the
  // `os-keychain` backend — a property of the host, not of the product. Windows
  // and macOS have one natively; no Linux CI runner does, so the CI job that
  // runs these lives on those two platforms.
  //
  // Skipping rather than failing, and only where a keyring genuinely is not
  // available: `global-setup.ts` publishes the backend it probed, and a job that
  // must have one sets FETCHPIER_TEST_REQUIRE_KEYRING so the run aborts before
  // reaching this point instead. The skip therefore cannot hide a regression on
  // a host that does have a keyring.
  test.skip(
    process.env.FETCHPIER_TEST_SECRETS_BACKEND !== 'os-keychain',
    `no OS keyring on this host (backend: ${process.env.FETCHPIER_TEST_SECRETS_BACKEND ?? 'unknown'}); ` +
      'keys would be held in memory and keystore.json never written'
  )

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  // SEC-008 — CA-01 / CA-08 / guarded delete (in-use is refused)
  test('lists a key with the In-use mark, exposes no key material, and refuses to delete it while in use', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    const ws = await createWorkspace(ctx)
    const { keyId } = await setupSecrets(page)

    // CA-08: wrap safeStorage.decryptString with a counter, then reset it right
    // before the tab loads its listing. Browsing must perform zero unwraps.
    await ctx.app.evaluate(({ safeStorage }) => {
      const g = globalThis as unknown as { __decryptCount: number; __decryptWrapped?: boolean }
      if (!g.__decryptWrapped) {
        const orig = safeStorage.decryptString.bind(safeStorage)
        ;(safeStorage as unknown as { decryptString: (b: Buffer) => string }).decryptString = (
          b: Buffer
        ): string => {
          g.__decryptCount = (g.__decryptCount ?? 0) + 1
          return orig(b)
        }
        g.__decryptWrapped = true
      }
      g.__decryptCount = 0
    })

    await openKeysTab(page)

    // CA-01: the row renders hint, keyId, In-use status and "Stored" storage.
    // Scope to the settings dialog — the workspace basename also shows in the sidebar.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(keyId, { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('cell', { name: basename(ws), exact: true })).toBeVisible()
    await expect(dialog.getByText('In use', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Stored', { exact: true })).toBeVisible()

    const decryptCount = await ctx.app.evaluate(
      () => (globalThis as unknown as { __decryptCount: number }).__decryptCount
    )
    expect(decryptCount).toBe(0)

    // Boundary: the listKeys payload carries no key material in any form.
    const listing = await page.evaluate(() =>
      (window as unknown as WindowWithApi).api.secrets.listKeys()
    )
    const serialized = JSON.stringify(listing)
    expect(serialized).not.toContain('enc:')
    expect(serialized).not.toContain('sealed:')
    expect(listing.entries[0]).not.toHaveProperty('key')

    // Guarded delete (REQ-0096): the key is referenced by this workspace, so the
    // delete action surfaces the "still in use" block — no typed path, no removal.
    await dialog.getByRole('button', { name: 'Delete' }).click()
    const blocked = page.getByRole('dialog').filter({ hasText: 'This key is still in use' })
    await expect(blocked).toBeVisible({ timeout: 10_000 })
    // The block names the offending workspace and offers no destructive path.
    await expect(blocked).toContainText(basename(ws))
    await expect(blocked.getByRole('button', { name: 'Delete key' })).toHaveCount(0)
    await blocked.getByRole('button', { name: 'Close' }).first().click()

    // Defense in depth: the IPC boundary enforces the same block.
    const rejection = await page.evaluate(async (id) => {
      try {
        await (window as unknown as WindowWithApi).api.secrets.deleteKey(id)
        return null
      } catch (e) {
        return String(e)
      }
    }, keyId)
    expect(rejection).toContain('KEY_IN_USE')

    // The key is untouched in the keystore, and the workspace still references it.
    const keystoreRaw = await fs.readFile(
      join(ctx.userDataDir, 'secrets', 'keystore.json'),
      'utf-8'
    )
    expect(keystoreRaw).toContain(keyId)
    const manifestRaw = await fs.readFile(join(ws, '.fetchpier', 'secrets.json'), 'utf-8')
    expect(manifestRaw).toContain(keyId)
  })

  // SEC-012 — a key that no known workspace references can be deleted, behind the
  // typed-confirmation gate. Reached by rotating: the rotated-out key is no longer
  // referenced (the new key is), so it becomes the deletable, not-referenced case.
  test('deletes a not-referenced key after typed confirmation, leaving the in-use key', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    const ws = await createWorkspace(ctx)
    const first = await setupSecrets(page)
    const second = await page.evaluate(() =>
      (window as unknown as WindowWithApi).api.secrets.rotate()
    )
    expect(second.keyId).not.toBe(first.keyId)

    await openKeysTab(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(first.keyId, { exact: true })).toBeVisible({ timeout: 10_000 })

    // Open the delete dialog for the not-referenced (rotated-out) key.
    const firstRow = dialog.getByRole('row').filter({ hasText: first.keyId })
    await firstRow.getByRole('button', { name: 'Delete' }).click()

    // This is the typed-confirmation path, not the blocked modal. The token is the
    // workspace name (the key's hint); Delete is gated until it is typed exactly.
    await expect(page.getByText('This key is still in use')).toHaveCount(0)
    const tokenInput = page.getByPlaceholder('Type the name exactly to enable Delete')
    await expect(tokenInput).toBeVisible({ timeout: 10_000 })
    await tokenInput.fill(basename(ws))
    await page.getByRole('button', { name: 'Delete key' }).click()

    // The not-referenced key is gone from the keystore; the in-use key remains.
    await expect(dialog.getByText(first.keyId, { exact: true })).toBeHidden({ timeout: 10_000 })
    await expect(dialog.getByText(second.keyId, { exact: true })).toBeVisible()
    const keystoreRaw = await fs.readFile(
      join(ctx.userDataDir, 'secrets', 'keystore.json'),
      'utf-8'
    )
    expect(keystoreRaw).not.toContain(first.keyId)
    expect(keystoreRaw).toContain(second.keyId)
  })

  // SEC-009 — CA-03 / CA-04 / CA-05
  test('proactive add: rejects bad structure, stores a valid key, no-ops on re-add', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    const ws = await createWorkspace(ctx)
    const { key, keyId } = await setupSecrets(page)
    // Reach the "key removed from keystore" precondition. Guarded delete (REQ-0096)
    // refuses a key an in-use workspace still references, so drop this workspace's
    // manifest reference first, then remove the keystore copy through the IPC.
    await fs.rm(join(ws, '.fetchpier', 'secrets.json'), { force: true })
    await page.evaluate(
      (id) => (window as unknown as WindowWithApi).api.secrets.deleteKey(id),
      keyId
    )

    await openKeysTab(page)
    await expect(page.getByText(/No workspace keys are stored/i)).toBeVisible({ timeout: 10_000 })

    // CA-04: a malformed key is rejected inline; nothing is stored.
    await page.getByRole('button', { name: 'Add a key' }).click()
    const keyInput = page.getByPlaceholder('FPK1-…')
    await keyInput.fill('FPK1-NOPE-NOPE-NOPE')
    await page.getByRole('button', { name: 'Add key' }).click()
    await expect(page.getByText(/checksum failed/i)).toBeVisible()
    await expect(page.getByText(keyId, { exact: true })).toBeHidden()

    // CA-03: the valid key is stored with its hint.
    await keyInput.fill(key)
    await page.getByPlaceholder('Which project is this for?').fill('from-teammate')
    await page.getByRole('button', { name: 'Add key' }).click()
    await expect(page.getByText(keyId, { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('from-teammate', { exact: true })).toBeVisible()

    // CA-05: re-adding the identical key is a silent no-op (no replace prompt).
    await page.getByRole('button', { name: 'Add a key' }).click()
    await page.getByPlaceholder('FPK1-…').fill(key)
    await page.getByRole('button', { name: 'Add key' }).click()
    await expect(page.getByText(/A key with this id already exists/i)).toBeHidden()
    // Still exactly one row for that keyId.
    await expect(page.getByText(keyId, { exact: true })).toHaveCount(1)
  })

  // Edge case: rotate (≈ clone-then-rotate) flips the old key to "Not referenced".
  test('rotate flips the previous key to the honest not-referenced mark', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    await createWorkspace(ctx)
    const first = await setupSecrets(page)
    const second = await page.evaluate(() =>
      (window as unknown as WindowWithApi).api.secrets.rotate()
    )
    expect(second.keyId).not.toBe(first.keyId)

    await openKeysTab(page)
    await expect(page.getByText(second.keyId, { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(first.keyId, { exact: true })).toBeVisible()
    // The current key is in use; the rotated-out key is referenced by no known
    // workspace — and the copy must never say "invalid/unused".
    await expect(page.getByText('In use', { exact: true })).toBeVisible()
    await expect(page.getByText('Not referenced', { exact: true })).toBeVisible()
  })

  // Edge case (user request): the stored copy of a key is corrupt; the user
  // re-pastes the real key and is offered a replacement. A conflict needs an
  // empty live-key cache, so this drives a second app process against the same
  // user-data dir (the natural "next launch" state).
  test('replace a corrupt stored key via the propose-replace prompt', async () => {
    ctx = await launchApp({ freshWorkspace: true })
    const page = ctx.window
    const ws = await createWorkspace(ctx)
    const { key, keyId } = await setupSecrets(page)
    const userDataDir = ctx.userDataDir

    // Close this process WITHOUT deleting the user-data dir or the workspace.
    await page
      .evaluate(async () => {
        const api = (
          window as unknown as { api?: { window?: { closeConfirmed?: () => Promise<void> } } }
        ).api
        if (api?.window?.closeConfirmed) await api.window.closeConfirmed()
      })
      .catch(() => undefined)
    await ctx.app.close().catch(() => undefined)
    ctx = null

    // Corrupt the wrapped material of the stored entry on disk.
    const keystorePath = join(userDataDir, 'secrets', 'keystore.json')
    const keystore = JSON.parse(await fs.readFile(keystorePath, 'utf-8')) as {
      version: number
      keys: Record<
        string,
        { key: string; createdAt: string; lastUsedAt?: string; workspaceHint?: string }
      >
    }
    keystore.keys[keyId].key = 'enc:v1:Y29ycnVwdGVk' // valid shape, undecryptable
    await fs.writeFile(keystorePath, JSON.stringify(keystore, null, 2), 'utf-8')

    // Relaunch against the same user-data dir → a fresh, empty live-key cache.
    const app2 = await _electron.launch({
      args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
      env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
    })
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')

      await page2.evaluate(() => window.dispatchEvent(new CustomEvent('app:openSettings')))
      await page2.getByRole('tab', { name: 'Workspace keys' }).click()
      // The corrupt entry still lists (metadata only, no unwrap).
      await expect(page2.getByText(keyId, { exact: true })).toBeVisible({ timeout: 10_000 })

      await page2.getByRole('button', { name: 'Add a key' }).click()
      await page2.getByPlaceholder('FPK1-…').fill(key)
      await page2.getByRole('button', { name: 'Add key' }).click()

      // CA-06: the unwrap fails (corrupt) so the keys differ → propose replace.
      await expect(page2.getByText(/A key with this id already exists/i)).toBeVisible({
        timeout: 10_000
      })
      await page2.getByRole('button', { name: 'Replace' }).click()

      // Wait for the replace to fully resolve (the dialog closes only after the
      // store + listing refresh complete) before asserting — otherwise the read
      // races between removeKey and storeWorkspaceKey.
      await expect(page2.getByText(/A key with this id already exists/i)).toBeHidden({
        timeout: 10_000
      })
      // The entry is restored; re-listing now decrypts cleanly.
      const ok = await page2.evaluate(async () => {
        const listing = await (window as unknown as WindowWithApi).api.secrets.listKeys()
        return listing.entries.length
      })
      expect(ok).toBe(1)
    } finally {
      await app2.close().catch(() => undefined)
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
