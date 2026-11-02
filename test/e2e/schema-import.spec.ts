import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { closeApp, launchApp, type ElectronAppContext } from './helpers/electron-app'

// REQ-0055 §4.5.3 — Schema import
//
// Opens the Import Schema modal once per Postman fixture under
// `test/workspaces/postman-import/`, pastes the JSON into the Text tab,
// imports, and asserts:
//   - The success banner shows the schema title from `info.name`.
//   - The expected warning categories appear (or do not).
//
// We use `environmentStrategy: 'none'` for all three so a missing env name
// can't block the Import button — the postman importer still emits the
// `variable-collected` and `script-copied-asis` warnings regardless of the
// write strategy, which is what we want to verify here.

const POSTMAN_FIXTURES_DIR = resolve('test', 'workspaces', 'postman-import')

interface Scenario {
  fileName: string
  expectedTitle: string
  expectedWarningLabels: string[]
  forbiddenWarningLabels: string[]
}

const SCENARIOS: readonly Scenario[] = [
  {
    fileName: 'tiny-collection.json',
    expectedTitle: 'Fetchpier Test — Tiny Collection',
    expectedWarningLabels: [],
    forbiddenWarningLabels: [
      'Variable collected into environment',
      'Postman script copied verbatim'
    ]
  },
  {
    fileName: 'collection-with-env-vars.json',
    expectedTitle: 'Fetchpier Test — Collection With Env Vars',
    expectedWarningLabels: ['Variable collected into environment'],
    forbiddenWarningLabels: ['Postman script copied verbatim']
  },
  {
    fileName: 'collection-with-scripts.json',
    expectedTitle: 'Fetchpier Test — Collection With Scripts',
    expectedWarningLabels: ['Postman script copied verbatim'],
    forbiddenWarningLabels: []
    // `variable-collected` may or may not appear depending on collection
    // structure; the with-scripts fixture has no collection-level variables,
    // so it should NOT appear — but we don't pin that strictly to avoid a
    // false-negative if a later fixture change adds incidental vars.
  }
]

async function importFixture(page: Page, scenario: Scenario): Promise<void> {
  const filePath = join(POSTMAN_FIXTURES_DIR, scenario.fileName)
  const content = await fs.readFile(filePath, 'utf-8')

  // Open the modal via the sidebar quick action.
  await page.getByRole('button', { name: 'Import schema' }).click()

  // The modal is the only `role="dialog"` element on screen — scope every
  // subsequent lookup to it so we don't collide with sidebar buttons named
  // the same thing (e.g. "Close" exists for the title-bar close button too).
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  // Switch to the Text tab and paste the JSON. shadcn's Tabs use real ARIA
  // roles, so getByRole('tab', ...) works here (unlike the response viewer's
  // plain <button> tabs).
  await dialog.getByRole('tab', { name: 'Text' }).click()
  const textarea = dialog.locator('textarea').first()
  await textarea.fill(content)

  // Pick the Postman format explicitly. The `<label>` isn't `htmlFor`-linked,
  // so we locate the native select by its option values instead.
  await dialog.locator('select').selectOption('postman')

  // Switch the environment strategy to "Don't import" so the Import button
  // is enabled regardless of whether an env name is filled in. This strategy
  // is only rendered when effectiveFormat === 'postman', which we just set.
  await dialog.getByRole('button', { name: "Don't import", exact: true }).click()

  // Trigger the import.
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()

  // Success banner contains the schema title from `info.name`.
  await expect(
    dialog.getByText(`Imported "${scenario.expectedTitle}" successfully`, { exact: false })
  ).toBeVisible({ timeout: 15_000 })

  for (const label of scenario.expectedWarningLabels) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible()
  }
  for (const label of scenario.forbiddenWarningLabels) {
    await expect(dialog.getByText(label, { exact: true })).toHaveCount(0)
  }

  // Close the modal via the result-screen Close button (the first one — the
  // dialog also has an X icon-button with the same accessible name in the
  // top-right corner).
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
  await expect(dialog).toBeHidden()
}

test.describe('schema import', () => {
  let ctx: ElectronAppContext | null = null

  test.beforeAll(async () => {
    // Use the default fixture: it has a stable `httpbin` env, so the "merge"
    // strategy is visible (though unused) and imported collections that happen
    // to share a base path don't collide.
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
  })

  test.afterAll(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  for (const scenario of SCENARIOS) {
    test(`imports ${scenario.fileName} and surfaces expected warnings`, async () => {
      if (!ctx) throw new Error('ctx not initialized')
      await importFixture(ctx.window, scenario)
    })
  }
})
