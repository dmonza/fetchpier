import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The two documents the app ever loads into a window. */
const RENDERER_DOCUMENTS = ['index.html', 'activity-panel-popout.html'] as const

export interface RendererUrlPolicyOptions {
  /** Dev-server URL (`ELECTRON_RENDERER_URL`) when running under `electron-vite dev`. */
  devUrl?: string
  /** Directory holding the built renderer documents (`out/renderer`). */
  rendererDir: string
}

/** Answers "is this URL one of the app's own renderer documents?". */
export type RendererUrlPolicy = (targetUrl: string) => boolean

/**
 * Builds the single definition of a trusted renderer document, shared by the
 * navigation guard, the IPC sender guard and the session permission policy.
 *
 * Packaged: a `file:` URL whose *path* is exactly one of the built documents —
 * compared as filesystem paths, not URL strings, so percent-encoding and drive
 * letter casing cannot lock the app out of its own IPC. A path that merely ends
 * in `/renderer/index.html` somewhere else on disk is not the app.
 *
 * Dev: any document on the dev server's exact origin (a shared string prefix
 * such as `:5173` vs `:51730` is not enough).
 */
export function createRendererUrlPolicy(options: RendererUrlPolicyOptions): RendererUrlPolicy {
  const devOrigin = options.devUrl ? new URL(options.devUrl).origin : null
  const trustedPaths = new Set(
    RENDERER_DOCUMENTS.map((doc) => comparablePath(join(options.rendererDir, doc)))
  )

  return (targetUrl: string): boolean => {
    let url: URL
    try {
      url = new URL(targetUrl)
    } catch {
      return false
    }
    if (devOrigin) return url.origin === devOrigin
    if (url.protocol !== 'file:') return false
    try {
      // `fileURLToPath` reads the pathname only — query and fragment are ignored.
      return trustedPaths.has(comparablePath(fileURLToPath(url)))
    } catch {
      return false
    }
  }
}

function comparablePath(p: string): string {
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}
