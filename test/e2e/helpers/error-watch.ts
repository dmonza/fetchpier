import type { ElectronAppContext } from './electron-app'

export interface ErrorWatcher {
  /** Errors emitted via `console.error` / `console.warning` in the renderer. */
  rendererConsoleErrors: string[]
  /** Uncaught exceptions surfaced via `pageerror`. */
  rendererPageErrors: Error[]
  /** Snapshot of unhandled promise rejections captured in the main process. */
  mainUnhandledRejections(): Promise<unknown[]>
}

/**
 * Centralizes error capture across renderer (console + pageerror) and main
 * process (unhandledRejection). Call once per spec, then assert that the
 * collected arrays are empty at the end of the happy-path flow.
 */
export async function watchErrors(ctx: ElectronAppContext): Promise<ErrorWatcher> {
  const rendererConsoleErrors: string[] = []
  const rendererPageErrors: Error[] = []

  ctx.window.on('console', (msg) => {
    if (msg.type() === 'error') rendererConsoleErrors.push(msg.text())
  })
  ctx.window.on('pageerror', (err) => rendererPageErrors.push(err))

  await ctx.app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any
    if (!g.__fpUnhandled) {
      g.__fpUnhandled = []
      process.on('unhandledRejection', (reason: unknown) => {
        ;(g.__fpUnhandled as unknown[]).push(reason)
      })
    }
  })

  return {
    rendererConsoleErrors,
    rendererPageErrors,
    async mainUnhandledRejections(): Promise<unknown[]> {
      return await ctx.app.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any
        return [...((g.__fpUnhandled as unknown[]) ?? [])]
      })
    }
  }
}
