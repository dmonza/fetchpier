import type { LicenseText } from '../types'

/**
 * Read a license file as a copyright notice plus the licence text itself.
 *
 * The copyright line is the first line that *starts with* `Copyright`, lifted
 * out verbatim so callers can surface it as a heading. It is a **copy**, not a
 * cut: `body` is the whole file, notice included, because the licence must be
 * displayable exactly as distributed. Only line endings are normalised and the
 * file's leading/trailing blank lines trimmed.
 *
 * A file with no such line yields `copyright: null` and the same full body.
 */
export function splitLicenseText(text: string): LicenseText {
  const normalized = text.replace(/\r\n/g, '\n')
  const copyright = normalized.split('\n').find((line) => line.startsWith('Copyright')) ?? null
  return { copyright, body: normalized.trim() }
}
