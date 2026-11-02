import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type ElectronAppContext } from './helpers/electron-app'

// Catalog: SEC-021 (CSP refuses script execution), SEC-022 (session permission
// policy). Runtime containment of whatever code ends up running in the renderer:
// the CSP keeps injected code from executing, and the permission policy keeps
// code that does execute from reaching device or OS capabilities.

test.describe('renderer containment', () => {
  let ctx: ElectronAppContext | null = null

  test.afterEach(async () => {
    if (ctx) {
      await closeApp(ctx)
      ctx = null
    }
  })

  test('SEC-021: CSP refuses inline scripts, eval and new Function', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { window: page } = ctx

    const outcome = await page.evaluate(async () => {
      const marker = window as unknown as { __fpInlineRan?: boolean }
      const script = document.createElement('script')
      script.textContent = 'window.__fpInlineRan = true'
      document.head.appendChild(script)
      // An inline script that is allowed runs synchronously on insertion; give a
      // refused one the same chance anyway before reading the marker.
      await new Promise((resolve) => setTimeout(resolve, 50))

      const refused = (run: () => unknown): boolean => {
        try {
          run()
          return false
        } catch {
          return true
        }
      }
      return {
        inlineRan: marker.__fpInlineRan === true,
        // Indirect eval, so the call is the global eval the CSP governs.
        evalRefused: refused(() => (0, window.eval)('1')),
        functionRefused: refused(() => new window.Function('return 1')())
      }
    })

    expect(outcome).toEqual({ inlineRan: false, evalRefused: true, functionRefused: true })
  })

  test('SEC-022: the app keeps the clipboard and is refused every other permission', async () => {
    ctx = await launchApp({ fixture: 'default' })
    const { app, window: page } = ctx

    // The clipboard is the developer's real one: put back what was there.
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
      await page.bringToFront()

      const outcome = await page.evaluate(async () => {
        const settle = async (run: () => Promise<unknown>): Promise<string> => {
          try {
            return `ok:${String(await run())}`
          } catch (err) {
            return `error:${err instanceof Error ? err.message : String(err)}`
          }
        }
        return {
          notifications: await Notification.requestPermission(),
          geolocation: await settle(
            () =>
              new Promise((resolve, reject) =>
                navigator.geolocation.getCurrentPosition(
                  resolve,
                  (e) => reject(new Error(`code ${e.code}`)),
                  { timeout: 3000 }
                )
              )
          ),
          clipboardWrite: await settle(() => navigator.clipboard.writeText('fp-sec-022')),
          clipboardRead: await settle(() => navigator.clipboard.readText())
        }
      })

      expect(outcome.notifications).toBe('denied')
      // PERMISSION_DENIED — not POSITION_UNAVAILABLE (2) or TIMEOUT (3), which a
      // granted request with no location provider would produce instead.
      expect(outcome.geolocation).toBe('error:code 1')
      expect(outcome.clipboardWrite).toBe('ok:undefined')
      expect(outcome.clipboardRead).toBe('ok:fp-sec-022')
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
    }
  })
})
