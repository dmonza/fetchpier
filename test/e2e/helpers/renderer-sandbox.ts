import type { ElectronApplication } from '@playwright/test'
import { promises as fs } from 'node:fs'

// Reads the operating system's own view of how the app's renderer processes are
// sandboxed. Shared on purpose by two callers that must never disagree about
// what they are reading:
//
//   - the host precondition in `global-setup.ts`, which asks "can this machine
//     sandbox a renderer at all?" and aborts the run before any spec if not;
//   - `sandbox.spec.ts`, which asserts the product's security invariant.
//
// The signal is platform-specific because the runtime exposes it that way.
// `ProcessMetric.sandboxed` is declared `@platform darwin,win32` and is always
// `undefined` on Linux, so asserting it there fails on a correctly sandboxed
// app. The Linux equivalent is the kernel's own view: the renderer sandbox
// installs a seccomp-bpf filter, reported as `Seccomp: 2` (SECCOMP_MODE_FILTER)
// in `/proc/<pid>/status`. An unsandboxed renderer leaves it at 0.
//
// Both branches deliberately avoid treating `getLastWebPreferences().sandbox` as
// the answer — it only echoes what was *requested*, not what the OS applied.
// That value is still read, but strictly as a discriminator (see `requested`).

/** SECCOMP_MODE_FILTER — a seccomp-bpf filter is installed on the process. */
export const SECCOMP_MODE_FILTER = 2

export interface RendererProcessView {
  pid: number
  /** `ProcessMetric.sandboxed`. `null` where the platform does not report it. */
  sandboxed: boolean | null
  /** Kernel seccomp mode. `null` off Linux, or when the field is absent. */
  seccomp: number | null
}

export interface SandboxObservation {
  /**
   * Whether the app *asked* for a sandboxed renderer.
   *
   * This is what separates "the host cannot sandbox" from "the product did not
   * request it". Without it, flipping `sandbox: false` in the product would
   * abort the whole suite blaming the runner — the precondition must stay
   * silent in that case and let the spec report the real cause.
   */
  requested: boolean
  renderers: RendererProcessView[]
}

/**
 * Is this renderer sandboxed, as far as the platform can tell?
 *
 * The single definition of the platform split, shared by the host precondition
 * and by `sandbox.spec.ts` so the two can never disagree. Linux never reports
 * the process metric, so the kernel's seccomp mode is the only signal there.
 * Everywhere else the metric is the documented one, and a missing value means
 * the signal was lost — which is not evidence of a sandbox.
 */
export function isOsSandboxed(platform: NodeJS.Platform, renderer: RendererProcessView): boolean {
  return platform === 'linux'
    ? renderer.seccomp === SECCOMP_MODE_FILTER
    : renderer.sandboxed === true
}

/** The kernel's `Seccomp` mode for a pid, or null if the field is absent. */
async function seccompMode(pid: number): Promise<number | null> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf-8')
    const match = /^Seccomp:\s+(\d+)$/m.exec(status)
    return match ? Number(match[1]) : null
  } catch {
    // The process may have exited between listing and reading; treat an
    // unreadable status as "no signal" rather than as a sandboxed process.
    return null
  }
}

/**
 * Read the OS's view of every renderer (`Tab`) process. The main (`Browser`)
 * process is deliberately excluded — it is not sandboxed by design.
 */
export async function readSandboxObservation(
  app: ElectronApplication
): Promise<SandboxObservation> {
  // `getLastWebPreferences()` is absent from the shipped Electron typings, so it
  // is reached through a cast and treated as optional. When it is unavailable we
  // cannot tell a host that cannot sandbox from a product that stopped asking,
  // so we assume it was requested: that keeps an unsandboxed renderer loud, and
  // the remedy text names both possible causes.
  const requested = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'window')
      .every((wc) => {
        const read = (
          wc as unknown as { getLastWebPreferences?: () => { sandbox?: boolean } | null }
        ).getLastWebPreferences
        if (typeof read !== 'function') return true
        return read.call(wc)?.sandbox !== false
      })
  )

  const metrics = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === 'Tab')
      .map((m) => ({ pid: m.pid, sandboxed: m.sandboxed ?? null }))
  )

  const renderers: RendererProcessView[] = await Promise.all(
    metrics.map(async (m) => ({
      ...m,
      seccomp: process.platform === 'linux' ? await seccompMode(m.pid) : null
    }))
  )

  return { requested, renderers }
}
