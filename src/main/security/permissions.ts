import type { Session } from 'electron'

import type { RendererUrlPolicy } from './renderer-origin'

/**
 * The only web permissions the renderer uses: `navigator.clipboard.writeText`
 * (copy actions) and `navigator.clipboard.readText` (the text menu's Paste).
 * Electron grants every permission by default, so anything not listed here —
 * notifications, camera/microphone, geolocation, screen capture, HID/serial/USB
 * — would otherwise be handed to whatever code ran in the renderer.
 */
const RENDERER_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write'
])

export type PermissionSession = Pick<
  Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'
>

export function isPermissionGranted(
  permission: string,
  requestingUrl: string | undefined,
  isTrustedUrl: RendererUrlPolicy
): boolean {
  return (
    RENDERER_PERMISSIONS.has(permission) &&
    requestingUrl !== undefined &&
    isTrustedUrl(requestingUrl)
  )
}

/**
 * Replaces Electron's grant-everything default with an allowlist: the clipboard
 * for the app's own documents, nothing for anyone else. Covers both the async
 * request path and the synchronous check path, and refuses device access
 * outright.
 */
export function installPermissionPolicy(
  session: PermissionSession,
  isTrustedUrl: RendererUrlPolicy
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details.requestingUrl || webContents.getURL()
    callback(isPermissionGranted(permission, url, isTrustedUrl))
  })
  session.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    const url = details.requestingUrl || webContents?.getURL()
    return isPermissionGranted(permission, url, isTrustedUrl)
  })
  session.setDevicePermissionHandler(() => false)
}
