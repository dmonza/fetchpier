import { DEFAULT_ACCEPT_ENCODING, desktopUserAgent } from '../../../shared/types'
import type { KeyValuePair } from '../../../shared/types'
import type { ManagedEntry } from './KeyValueEditor'

/**
 * The default request headers the engine adds at send time when the request
 * carries no enabled header of that name — shown in the headers editor as
 * read-only rows so the user sees what goes out, and never saved into the file.
 * Writing a header of the same name replaces the row; deleting it brings the row
 * back. `appVersion` is `null` until the app reports it (the row then reads
 * `Fetchpier`).
 */
export function implicitDefaultHeaderEntries(
  headers: KeyValuePair[],
  appVersion: string | null
): ManagedEntry[] {
  const present = new Set(
    headers.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase())
  )
  const out: ManagedEntry[] = []
  if (!present.has('user-agent')) {
    out.push({
      key: 'User-Agent',
      value: appVersion ? desktopUserAgent(appVersion) : 'Fetchpier'
    })
  }
  if (!present.has('accept-encoding')) {
    out.push({ key: 'Accept-Encoding', value: DEFAULT_ACCEPT_ENCODING })
  }
  return out
}
