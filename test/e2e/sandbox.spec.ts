import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'
import { readSandboxObservation, isOsSandboxed } from './helpers/renderer-sandbox'

// REQ-0060 — regression net for the OS-level renderer sandbox.
//
// Four assertions, together proving (a) the sandbox is actually on, (b) the
// renderer's main world has no Node, (c) the contextBridge still works, and
// (d) the typed `api` is the only bridge on it:
//
//   (a) Every renderer (Tab) process is sandboxed at the OS level. This is the
//       load-bearing check — `window.process === undefined` (below) is already
//       true under contextIsolation even with sandbox:false, so it alone does
//       NOT prove the flag is on. The signal must also be stronger than the
//       requested webPreference (`getLastWebPreferences().sandbox` only echoes
//       what was asked for); it has to reflect the actual process.
//   (b) From the renderer's main world, `window.process` and `window.require`
//       are `undefined`.
//   (c) A representative IPC round-trip (`window.api.app.getVersion()`) resolves
//       to a string.
//   (d) `window.electron` is `undefined`. The preload used to also expose
//       `@electron-toolkit/preload`'s `electronAPI`, which is raw
//       `ipcRenderer.send/invoke/on` over *any* channel plus a `process.env`
//       getter — a general-purpose bridge sitting next to the typed one, and a
//       direct contradiction of the §1.2 rule that the renderer never sees a
//       raw channel name. Nothing consumed it. This assertion keeps it gone.
//
// If someone later flips `sandbox` back to `false`, assertion (a) fails here.
//
// (a) is read per platform by `helpers/renderer-sandbox.ts`, which the host
// precondition in `global-setup.ts` also uses — so a run that got past the
// precondition and a run that fails here can never disagree about what they
// read. The precondition answers "can this host sandbox at all?"; this spec
// answers "does the product still ask for it, and get it?".
//
// On a host that cannot sandbox at all — a CI runner is the known case, where
// the ecosystem's usual answer is to disable the sandbox outright — the OS-level
// half of (a) is waived, loudly, and the invariant is verified on the platforms
// that can honor it instead. The waiver is scoped as tightly as possible: the
// app must still *request* a sandbox everywhere, and (b)–(d) do not depend on
// one, so they keep running.

/** Set only by jobs on a host known to be unable to sandbox. */
const SANDBOX_WAIVE_ALLOWED = /^(1|true|yes)$/i.test(
  process.env.FETCHPIER_TEST_ALLOW_UNSANDBOXED?.trim() ?? ''
)

test.describe('renderer sandbox', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('renderer runs sandboxed and the IPC bridge still works', async () => {
    ctx = await launchApp({ fixture: 'default', autoOpen: true })
    const { app, window: page } = ctx

    // (a) The renderer is actually OS-sandboxed. The main process supplies the
    // renderer inventory; the main (Browser) process is not sandboxed, so the
    // reader filters to Tab only.
    const { requested, renderers } = await readSandboxObservation(app)
    expect(renderers.length).toBeGreaterThan(0)

    // The app must keep *asking* for a sandbox on every host, waiver or not —
    // that half is about the product and nothing external can excuse it.
    expect(requested, 'the app no longer requests a sandboxed renderer').toBe(true)

    const unsandboxed = renderers.filter((r) => !isOsSandboxed(process.platform, r))

    if (SANDBOX_WAIVE_ALLOWED && unsandboxed.length > 0) {
      // The host genuinely cannot deliver one (see global-setup's waiver), and
      // re-asserting would only repeat a host limitation the run already
      // announced. Note the ordering: the waiver is keyed on what was OBSERVED,
      // not on the flag alone — a capable host still gets asserted even with the
      // flag set, so enabling it can never silently drop real coverage.
      test.info().annotations.push({
        type: 'waived',
        description: 'host cannot sandbox the renderer; OS-level check verified on other platforms'
      })
    } else {
      expect(
        unsandboxed.map((r) => r.pid),
        'these renderer processes are not sandboxed by the OS'
      ).toEqual([])
    }

    // (b) The renderer's main world has no Node surface.
    const mainWorld = await page.evaluate(() => ({
      process: typeof (window as unknown as { process?: unknown }).process,
      require: typeof (window as unknown as { require?: unknown }).require
    }))
    expect(mainWorld.process).toBe('undefined')
    expect(mainWorld.require).toBe('undefined')

    // (c) The contextBridge API is present and a cheap IPC route round-trips.
    const version = await page.evaluate(() =>
      (
        window as unknown as { api: { app: { getVersion: () => Promise<string> } } }
      ).api.app.getVersion()
    )
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)

    // (d) The typed `api` is the only bridge exposed on the main world.
    const untypedBridge = await page.evaluate(
      () => typeof (window as unknown as { electron?: unknown }).electron
    )
    expect(untypedBridge).toBe('undefined')
  })
})
