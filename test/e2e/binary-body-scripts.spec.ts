import { test, expect, type Page } from '@playwright/test'

import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'
import { readLatestHistoryRun } from './helpers/history-runs'

// PLAN-0044 — fp.* sandbox read-only contract for binary bodies.
//
// Each test loads a pre-seeded `.http` from the binary-tests fixture whose
// script either reads the contract or tries to violate it, then asserts the
// observable outcome.
//
// Why we inspect disk instead of the Tests tab UI:
//   - The Tests tab `<button>` name varies with a failure badge ("Tests" vs
//     "Tests 1") and matching it across both states is brittle.
//   - The script results are also serialized to the history file under
//     `requests/.runs/`, and the environment file is rewritten on
//     `fp.environment.set(...)`. Both are stable across UI changes.
//
// Cases covered:
//   1. Pre-request: bodyType / binaryFileRef readable, body undefined —
//      asserted by reading the environment file written by the script.
//   2. Pre-request: assigning `fp.request.body` throws — the request never
//      sends and the response viewer shows "Pre-request script failed" with
//      a binary-related reason.
//   3. Post-response: same read-only contract — the history entry's
//      `scriptResults.postResponse.error` carries the expected message.

// REQ-0074: `fp.environment.set(...)` from scripts persists to the LOCAL value
// layer (`environments/<id>/.state/localvalues.json`), never the shared
// `config.json` (CA-02). We therefore read the script-written variables through
// the same IPC view the editor uses, mirroring `environment-local-values.spec.ts`.
interface LocalRow {
  name: string
  localDisplay?: string
}
interface LocalView {
  rows: LocalRow[]
}
type WindowWithApi = Window & {
  api: { localValues: { getView: (envId: string) => Promise<LocalView> } }
}

/**
 * Read a single script-written value from the default environment's local layer.
 * The contract variables are local-only and plain, so `localDisplay` carries the
 * raw value (secrets would be masked — not the case here). Returns `undefined`
 * when the variable has not been written yet.
 */
async function readLocalValue(page: Page, name: string): Promise<string | undefined> {
  const view = await page.evaluate(
    (id) => (window as unknown as WindowWithApi).api.localValues.getView(id),
    'default'
  )
  return view.rows.find((r) => r.name === name)?.localDisplay
}

// REQ-0068: entries are now `.http`; we share the parser with binary-body.spec.ts.
const readLatestHistory = readLatestHistoryRun

async function openRequestBody(page: Page, name: string): Promise<void> {
  const row = page.getByRole('treeitem', { name, exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const bodyTab = page.getByRole('button', { name: 'Body', exact: true }).first()
  await expect(bodyTab).toBeVisible({ timeout: 10_000 })
  await bodyTab.click()
}

async function clickSend(page: Page): Promise<void> {
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true })
  await expect(sendBtn).toBeVisible({ timeout: 10_000 })
  await sendBtn.click()
}

test.describe('binary body — fp.* sandbox contract', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('pre-request: bodyType / binaryFileRef readable, body undefined', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await openRequestBody(page, 'script-pre-reads')
    await clickSend(page)
    await expect(page.getByText(/^2\d{2} /)).toBeVisible({ timeout: 25_000 })

    // The script wrote three env variables to the local value layer — verify them
    // through the IPC view (REQ-0074: scripts never touch the shared config.json).
    await expect.poll(async () => readLocalValue(page, 'contractBodyType')).toBe('binary')
    expect(await readLocalValue(page, 'contractRefType')).toBe('string')
    expect(await readLocalValue(page, 'contractBodyTypeof')).toBe('undefined')
  })

  test('pre-request: assigning fp.request.body throws and blocks the send', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await openRequestBody(page, 'script-pre-assigns')
    await clickSend(page)

    // The error surface in the body tab confirms the request never sent.
    await expect(page.getByText(/Pre-request script failed/i)).toBeVisible({
      timeout: 15_000
    })

    // The renderer-visible error string already encodes the sandbox message —
    // assert against the page text rather than chasing it through a separate
    // history entry (the pre-request failure short-circuits before history
    // is written).
    const bodyText = await page.locator('body').textContent()
    expect(bodyText ?? '').toMatch(/binary|read-only/i)
  })

  test('post-response: assigning fp.request.body throws after the send', async () => {
    ctx = await launchApp({ fixture: 'binary-tests', autoOpen: true })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected binary-tests fixture')

    await openRequestBody(page, 'script-post-assigns')
    await clickSend(page)

    // Send completed — response landed.
    await expect(page.getByText(/^2\d{2} /)).toBeVisible({ timeout: 25_000 })

    // The post-response script throw is captured in the history entry.
    await expect
      .poll(async () => {
        const entry = await readLatestHistory(workspace.path)
        return entry?.scriptResults?.postResponse?.success
      })
      .toBe(false)
    const finalEntry = await readLatestHistory(workspace.path)
    const msg = finalEntry?.scriptResults?.postResponse?.error?.message ?? ''
    expect(msg).toMatch(/binary|read-only/i)
  })
})
