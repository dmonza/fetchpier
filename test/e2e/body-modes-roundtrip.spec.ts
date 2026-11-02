import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  launchApp,
  closeApp,
  stubNativeDialogs,
  APP_LAUNCH_PATH,
  APP_VERSION,
  type ElectronAppContext
} from './helpers/electron-app'

// PLAN-0077 — Round-trip every body mode through save → close → reopen.
//
// For each of the 9 modes the UI exposes (none, raw×5, x-www-form-urlencoded,
// multipart-form, binary):
//   - fill representative data in the renderer
//   - save the .http to disk
//   - reload the request and assert that both the renderer state AND the on-disk
//     .http preserve the mode + data.
//
// Two reload depths cover different layers:
//   • close+reopen tab (renderer-side parser + editor mapping)
//   • full Electron restart (disk → main → renderer hydration)

const REPO_ROOT = process.cwd()
const HELLO_TXT = join(REPO_ROOT, 'test', 'fixtures', 'binary', 'hello.txt')
const TARGET_NAME = 'target'

type RawSubtype = 'json' | 'xml' | 'javascript' | 'text' | 'html'

interface BaseCase {
  /** Unique label used both as Playwright test name and (visually) for log diffs. */
  label: string
}

type ModeCase = BaseCase &
  (
    | { kind: 'none' }
    | { kind: 'raw'; subtype: RawSubtype; body: string }
    | { kind: 'x-www-form-urlencoded'; pairs: Array<{ key: string; value: string }> }
    | {
        kind: 'multipart-form'
        textName: string
        textValue: string
        fileFieldName: string
      }
    | { kind: 'binary' }
  )

const MODES: ModeCase[] = [
  { label: 'none', kind: 'none' },
  { label: 'raw-json', kind: 'raw', subtype: 'json', body: '{"hello":"world"}' },
  { label: 'raw-xml', kind: 'raw', subtype: 'xml', body: '<root><a>1</a></root>' },
  { label: 'raw-javascript', kind: 'raw', subtype: 'javascript', body: 'const x = 1' },
  { label: 'raw-text', kind: 'raw', subtype: 'text', body: 'plain text content' },
  { label: 'raw-html', kind: 'raw', subtype: 'html', body: '<p>Hello</p>' },
  {
    label: 'x-www-form-urlencoded',
    kind: 'x-www-form-urlencoded',
    pairs: [
      { key: 'a', value: '1' },
      { key: 'b', value: '2' }
    ]
  },
  {
    label: 'multipart-form',
    kind: 'multipart-form',
    textName: 'field1',
    textValue: 'val1',
    fileFieldName: 'upload'
  },
  { label: 'binary', kind: 'binary' }
]

// ---------- Helpers ------------------------------------------------------------

/** Click the request row in the sidebar and switch to the Body sub-tab. */
async function openTarget(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: TARGET_NAME, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
  await expect(bodyTab).toBeVisible({ timeout: 10_000 })
  await bodyTab.click()
  await expect(page.locator('input[name="body-type"]').first()).toBeVisible({
    timeout: 5_000
  })
}

async function setBodyType(page: Page, type: string): Promise<void> {
  const radio = page.locator(`input[name="body-type"][value="${type}"]`)
  await expect(radio).toBeVisible({ timeout: 5_000 })
  await radio.check()
}

async function setRawSubtype(page: Page, subtype: RawSubtype): Promise<void> {
  const select = page.getByLabel('Format:')
  await expect(select).toBeVisible({ timeout: 5_000 })
  await select.selectOption(subtype)
}

/** Focus CodeMirror and type the body verbatim. Single-line inputs only. */
async function fillRawBody(page: Page, text: string): Promise<void> {
  const cm = page.locator('.cm-content').first()
  await expect(cm).toBeVisible({ timeout: 5_000 })
  await cm.click()
  await page.keyboard.type(text)
}

async function fillFormUrlencoded(
  page: Page,
  pairs: Array<{ key: string; value: string }>
): Promise<void> {
  for (let i = 0; i < pairs.length; i++) {
    // KeyValueEditor footer button — only visible inside the Body sub-tab.
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.getByPlaceholder('Key').nth(i).fill(pairs[i].key)
    await page.getByPlaceholder('Value').nth(i).fill(pairs[i].value)
  }
}

/**
 * Both BinaryBodyPicker and MultipartPartRow render a "Choose file…" trigger
 * that opens a StagedFilePicker popover; clicking the popover's "Select local
 * file…" footer triggers the native open dialog (stubbed by the spec).
 */
async function stageNewFromPopover(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Select local file/ }).click()
}

async function fillMultipartTextPart(page: Page, name: string, value: string): Promise<void> {
  await page
    .getByRole('button', { name: /Add text part/ })
    .first()
    .click()
  await page.getByPlaceholder('field name').last().fill(name)
  await page.getByPlaceholder('value').last().fill(value)
}

async function fillMultipartFilePart(page: Page, name: string): Promise<void> {
  await page
    .getByRole('button', { name: /Add file part/ })
    .first()
    .click()
  await page.getByPlaceholder('field name').last().fill(name)
  await page
    .getByRole('button', { name: /Choose file/ })
    .first()
    .click()
  await stageNewFromPopover(page)
  // Block until the staged filename is reflected in the renderer state.
  // Without this, the IPC round-trip (binary.selectAndStage → store update)
  // may still be in flight when the caller fires saveTab, and the serializer
  // writes the .http without the file marker — see body-modes-roundtrip race.
  await expect(page.getByText('hello.txt').first()).toBeVisible({ timeout: 5_000 })
}

async function pickBinaryFile(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Choose file/ })
    .first()
    .click()
  await stageNewFromPopover(page)
  // Same rationale as fillMultipartFilePart: wait for the BinaryBodyPicker to
  // reflect the staged file before letting the caller move on to saveTab.
  await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 5_000 })
}

/** Trigger the renderer's SAVE_NOW_EVENT and wait until the .http mtime bumps. */
async function saveTab(page: Page, httpFilePath: string): Promise<void> {
  const before = await fs.stat(httpFilePath).then(
    (s) => s.mtimeMs,
    () => 0
  )
  await page.evaluate(() => {
    window.dispatchEvent(new Event('app:saveNow'))
  })
  await expect
    .poll(async () => {
      const s = await fs.stat(httpFilePath).catch(() => null)
      return s ? s.mtimeMs : 0
    })
    .toBeGreaterThan(before)
}

async function closeActiveTab(page: Page, tabName: string): Promise<void> {
  const tab = page.getByRole('tab', { name: tabName })
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
  await expect(page.locator('input[name="body-type"]')).toHaveCount(0, {
    timeout: 5_000
  })
}

async function applyModeData(page: Page, c: ModeCase): Promise<void> {
  // The fixture target.http starts in `none` mode. For the `none` case we need
  // to dirty the tab so the save fires — toggle into raw and back.
  if (c.kind === 'none') {
    await setBodyType(page, 'raw')
  }
  await setBodyType(page, c.kind)

  switch (c.kind) {
    case 'none':
      break
    case 'raw':
      await setRawSubtype(page, c.subtype)
      await fillRawBody(page, c.body)
      break
    case 'x-www-form-urlencoded':
      await fillFormUrlencoded(page, c.pairs)
      break
    case 'multipart-form':
      await fillMultipartTextPart(page, c.textName, c.textValue)
      await fillMultipartFilePart(page, c.fileFieldName)
      break
    case 'binary':
      await pickBinaryFile(page)
      break
  }
}

async function verifyUi(page: Page, c: ModeCase): Promise<void> {
  const radio = page.locator(`input[name="body-type"][value="${c.kind}"]`)
  await expect(radio).toBeVisible({ timeout: 10_000 })
  await expect(radio).toBeChecked()

  switch (c.kind) {
    case 'none':
      await expect(page.getByText('This request has no body.')).toBeVisible({
        timeout: 5_000
      })
      break
    case 'raw': {
      const select = page.getByLabel('Format:')
      await expect(select).toHaveValue(c.subtype, { timeout: 5_000 })
      const cm = page.locator('.cm-content').first()
      await expect(cm).toBeVisible({ timeout: 5_000 })
      await expect(cm).toContainText(c.body, { timeout: 5_000 })
      break
    }
    case 'x-www-form-urlencoded':
      for (let i = 0; i < c.pairs.length; i++) {
        await expect(page.getByPlaceholder('Key').nth(i)).toHaveValue(c.pairs[i].key, {
          timeout: 5_000
        })
        await expect(page.getByPlaceholder('Value').nth(i)).toHaveValue(c.pairs[i].value, {
          timeout: 5_000
        })
      }
      break
    case 'multipart-form':
      await expect(page.getByPlaceholder('field name').nth(0)).toHaveValue(c.textName, {
        timeout: 5_000
      })
      await expect(page.getByPlaceholder('value').nth(0)).toHaveValue(c.textValue, {
        timeout: 5_000
      })
      await expect(page.getByPlaceholder('field name').nth(1)).toHaveValue(c.fileFieldName, {
        timeout: 5_000
      })
      await expect(page.getByText('hello.txt')).toBeVisible({ timeout: 5_000 })
      break
    case 'binary':
      await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({
        timeout: 5_000
      })
      await expect(page.getByText(/13 B/)).toBeVisible({ timeout: 5_000 })
      await expect(page.getByText(/text\/plain/)).toBeVisible({ timeout: 5_000 })
      break
  }
}

async function verifyHttpFile(httpFilePath: string, c: ModeCase): Promise<void> {
  const raw = await fs.readFile(httpFilePath, 'utf-8')
  switch (c.kind) {
    case 'none':
      expect(raw).not.toMatch(/^#\s*@rawSubtype:/m)
      expect(raw).not.toMatch(/^#\s*@binary-file:/m)
      expect(raw).not.toMatch(/^#\s*@multipart begin/m)
      break
    case 'raw':
      if (c.subtype === 'text') {
        expect(raw).not.toMatch(/^#\s*@rawSubtype:/m)
      } else {
        const re = new RegExp(`^#\\s*@rawSubtype:\\s*${c.subtype}\\s*$`, 'm')
        expect(raw).toMatch(re)
      }
      expect(raw).toContain(c.body)
      break
    case 'x-www-form-urlencoded': {
      const pairText = c.pairs.map((p) => `${p.key}=${p.value}`).join('&')
      expect(raw).toContain(pairText)
      break
    }
    case 'multipart-form':
      expect(raw).toMatch(/^#\s*@multipart begin\b/m)
      expect(raw).toMatch(/^#\s*@multipart end\b/m)
      expect(raw).toMatch(new RegExp(`name="${c.textName}"`))
      expect(raw).toMatch(new RegExp(`name="${c.fileFieldName}"`))
      expect(raw).toMatch(/[a-f0-9]{64}__hello\.txt/)
      break
    case 'binary':
      expect(raw).toMatch(/^#\s*@binary-file:\s*[a-f0-9]{64}__hello\.txt\s*$/m)
      break
  }
}

async function seedRestartUserData(userDataDir: string, workspacePath: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(
    join(userDataDir, 'last-workspace.json'),
    JSON.stringify({ path: workspacePath, recent: [workspacePath] }, null, 2),
    'utf-8'
  )
  await fs.writeFile(
    join(userDataDir, 'appsettings.json'),
    JSON.stringify(
      {
        language: 'en',
        zoomFactor: 1,
        // Mark the current version as seen: otherwise the once-per-version
        // About dialog opens over the UI this spec drives.
        lastVersion: APP_VERSION,
        updates: {
          autoCheckEnabled: false,
          intervalDays: 30,
          lastCheckAt: new Date().toISOString()
        }
      },
      null,
      2
    ),
    'utf-8'
  )
}

async function launchAgainstWorkspace(
  workspacePath: string
): Promise<{ app: ElectronApplication; window: Page; userDataDir: string }> {
  const userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-e2e-body-modes-relaunch-'))
  await seedRestartUserData(userDataDir, workspacePath)
  const app = await electron.launch({
    args: [APP_LAUNCH_PATH, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: { ...process.env, FETCHPIER_DISABLE_UPDATES: '1' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window, userDataDir }
}

// ---------- Specs --------------------------------------------------------------

test.describe('body modes — round-trip (close+reopen within session)', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  for (const c of MODES) {
    test(`${c.label} mode persists across close+reopen`, async () => {
      ctx = await launchApp({ fixture: 'body-modes', autoOpen: true })
      const { window: page, workspace } = ctx
      if (!workspace) throw new Error('expected body-modes fixture')
      const httpFile = join(workspace.path, 'requests', `${TARGET_NAME}.http`)

      if (c.kind === 'binary' || c.kind === 'multipart-form') {
        await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
      }

      await openTarget(page)
      await applyModeData(page, c)
      await saveTab(page, httpFile)

      await closeActiveTab(page, TARGET_NAME)
      await openTarget(page)

      await verifyUi(page, c)
      await verifyHttpFile(httpFile, c)
    })
  }
})

test.describe('body modes — round-trip (full app restart)', () => {
  let ctx: ElectronAppContext | null = null
  let relaunch: { app: ElectronApplication; userDataDir: string } | null = null
  let preservedPath: string | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx, { keepWorkspacePaths: Boolean(preservedPath) })
      ctx = null
    }
    if (relaunch) {
      try {
        await relaunch.app.close()
      } catch {
        /* ignore */
      }
      await fs.rm(relaunch.userDataDir, { recursive: true, force: true }).catch(() => undefined)
      relaunch = null
    }
    if (preservedPath) {
      await fs.rm(preservedPath, { recursive: true, force: true }).catch(() => undefined)
      preservedPath = null
    }
  })

  for (const c of MODES) {
    test(`${c.label} mode persists across full restart`, async () => {
      ctx = await launchApp({ fixture: 'body-modes', autoOpen: true })
      const { window: page, workspace } = ctx
      if (!workspace) throw new Error('expected body-modes fixture')
      const httpFile = join(workspace.path, 'requests', `${TARGET_NAME}.http`)

      if (c.kind === 'binary' || c.kind === 'multipart-form') {
        await stubNativeDialogs(ctx, { pickPath: HELLO_TXT })
      }

      await openTarget(page)
      await applyModeData(page, c)
      await saveTab(page, httpFile)

      preservedPath = workspace.path
      await closeApp(ctx, { keepWorkspacePaths: true })
      ctx = null

      relaunch = await launchAgainstWorkspace(preservedPath)
      const page2 = relaunch.app.windows()[0]
      await page2.waitForLoadState('domcontentloaded')

      await openTarget(page2)
      await verifyUi(page2, c)
      await verifyHttpFile(httpFile, c)
    })
  }
})
