import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// REQ-0061 — network egress invariant, runtime regression net.
//
// The invariant (README, "Declared network egress"): every byte of network egress originates from
// `@fetchpier/core` (undici) or the main-process update check. The renderer
// performs NO network I/O.
//
// What this spec can and cannot see: Playwright's `_electron` request listener
// observes the *renderer page* only — not main-process undici, not the Chromium
// Network Service. That is exactly the surface this test should pin: when the
// user clicks Send, the HTTP round-trip happens in the MAIN process, so the
// renderer must issue zero remote requests throughout the session. If a remote
// font, image, or script ever crept into the bundle, it would surface here as an
// http(s) request from the page. OS-level egress is covered by the undici-only
// architecture + the manual checks in REQ-0061 §5.
//
// It also asserts the seven Chromium egress-coherence switches (Task 4.5) are
// actually applied at runtime — `appendSwitch` before `whenReady` is otherwise a
// silent no-op.

const ALLOWED_PROTOCOLS = new Set(['file:', 'data:', 'blob:', 'about:', 'devtools:', 'chrome:'])

test.describe('network egress invariant', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('renderer issues no remote requests during a representative session', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page, workspace } = ctx
    if (!workspace) throw new Error('expected default fixture to be copied')

    // Capture every request the renderer page (and its frames) originates.
    const remoteRequests: string[] = []
    page.on('request', (req) => {
      let protocol: string
      try {
        protocol = new URL(req.url()).protocol
      } catch {
        return // opaque/malformed — not a remote egress
      }
      if (!ALLOWED_PROTOCOLS.has(protocol)) {
        remoteRequests.push(`${req.method()} ${req.url()}`)
      }
    })

    // Representative session: open workspace → open request → Send → 200 OK.
    // The Send round-trip runs in MAIN (undici); the renderer must stay silent.
    const wsName = workspace.path.split(/[\\/]/).pop() as string
    const recentButton = page.getByRole('button', { name: wsName })
    await expect(recentButton).toBeVisible({ timeout: 15_000 })
    await recentButton.click()

    const requestRow = page.getByRole('treeitem', { name: 'get-httpbin' })
    await expect(requestRow).toBeVisible({ timeout: 15_000 })
    await requestRow.click()

    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await expect(sendButton).toBeVisible({ timeout: 15_000 })
    await sendButton.click()

    await expect(page.getByText('200 OK', { exact: true })).toBeVisible({ timeout: 20_000 })

    // The HTTP send went through the main process; the renderer made no remote request.
    expect(
      remoteRequests,
      `renderer originated remote network requests (network egress invariant violated):\n${remoteRequests.join('\n')}`
    ).toEqual([])
  })

  test('Chromium egress-coherence switches are applied at runtime', async () => {
    ctx = await launchApp({ fixture: 'default' })

    const switches = await ctx.app.evaluate(({ app }) => ({
      backgroundNetworking: app.commandLine.hasSwitch('disable-background-networking'),
      defaultApps: app.commandLine.hasSwitch('disable-default-apps'),
      sync: app.commandLine.hasSwitch('disable-sync'),
      componentUpdate: app.commandLine.hasSwitch('disable-component-update'),
      domainReliability: app.commandLine.hasSwitch('disable-domain-reliability'),
      noPings: app.commandLine.hasSwitch('no-pings'),
      disableFeatures: app.commandLine.getSwitchValue('disable-features')
    }))

    expect(switches.backgroundNetworking).toBe(true)
    expect(switches.defaultApps).toBe(true)
    expect(switches.sync).toBe(true)
    expect(switches.componentUpdate).toBe(true)
    expect(switches.domainReliability).toBe(true)
    expect(switches.noPings).toBe(true)
    // The REQ-0061 feature flags share the single disable-features list with the
    // REQ-0059 memory flags.
    expect(switches.disableFeatures).toContain('ChromeWhatsNewUI')
    expect(switches.disableFeatures).toContain('OptimizationHints')
    expect(switches.disableFeatures).toContain('InterestFeedContentSuggestions')
  })

  // Runtime backstop of the egress invariant: the CSP refuses any
  // off-origin connection from the renderer regardless of what code runs in it.
  test('CSP refuses an off-origin connection from the renderer', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page } = ctx

    const outcome = await page.evaluate(async () => {
      try {
        // `window.fetch` (not the bare global) — exercised here only to prove the
        // CSP blocks it; product renderer code never originates network traffic.
        await window.fetch('https://example.com/')
        return 'allowed'
      } catch (err) {
        return `blocked:${err instanceof Error ? err.message : String(err)}`
      }
    })

    expect(
      outcome.startsWith('blocked'),
      `expected CSP to block off-origin fetch, got: ${outcome}`
    ).toBe(true)
  })

  // The navigation guard keeps the privileged preload from ever attaching to a
  // remote origin: a renderer-initiated top-level navigation off the app is denied.
  test('navigation guard blocks top-level navigation to a remote origin', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page } = ctx

    const before = page.url()
    expect(before).toMatch(/index\.html$/)

    await page
      .evaluate(() => {
        window.location.href = 'https://example.com/'
      })
      .catch(() => {
        // Setting location may reject if the context tears down — irrelevant.
      })

    // Give any (blocked) navigation a chance to take effect, then assert the
    // renderer is still on the packaged document.
    await page.waitForTimeout(500)
    expect(page.url()).toBe(before)
  })
})

// REQ-0113 §6.7 — new-window containment covers EVERY window, not just the first.
//
// `setWindowOpenHandler` used to be installed on the main window at creation, so
// the activity-panel popout had none: content there could open a real Chromium
// window carrying the privileged preload. The handler now rides the same
// `web-contents-created` hook as the navigation guard above, which is what makes
// this assertion about the *popout* the discriminating one — asserting it on the
// main window would have passed before the fix too.
test.describe('new-window containment', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('the activity-panel popout denies window.open and routes the address out', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const { app, window: page } = ctx

    // `shell.openExternal` MUST be stubbed before triggering: the handler under
    // test deliberately hands http(s) addresses to the system browser, so an
    // unstubbed run pops a real tab on the developer's machine on every
    // execution of this suite. Stubbing also turns the side effect into an
    // assertion — we can check *what* was routed out, not just that the window
    // was denied.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __fpOpenedExternally: string[] }
      g.__fpOpenedExternally = []
      const s = shell as unknown as { openExternal: (url: string) => Promise<void> }
      s.openExternal = async (url: string): Promise<void> => {
        g.__fpOpenedExternally.push(url)
      }
    })

    const before = app.windows().length
    await page.evaluate(() =>
      (
        window as unknown as { api: { activityPanel: { popout: () => Promise<unknown> } } }
      ).api.activityPanel.popout()
    )
    const popout = await app.waitForEvent('window')
    await popout.waitForLoadState('domcontentloaded')
    const withPopout = app.windows().length
    expect(withPopout).toBe(before + 1)

    // From the popout itself. The load-bearing assertion is the RETURN VALUE:
    // a handler returning `{action:'deny'}` makes `window.open` yield null.
    // Merely counting windows does not discriminate — with no handler at all
    // nothing visible materializes either, so that assertion passes both ways.
    const denied = await popout.evaluate(
      () => window.open('https://example.com/', '_blank') === null
    )
    expect(denied).toBe(true)

    await popout.waitForTimeout(300)
    expect(app.windows().length).toBe(withPopout)

    // The policy is deny-the-window *and* hand the address to the system browser.
    const routed = await app.evaluate(
      () => (globalThis as unknown as { __fpOpenedExternally: string[] }).__fpOpenedExternally
    )
    expect(routed).toEqual(['https://example.com/'])
  })
})
