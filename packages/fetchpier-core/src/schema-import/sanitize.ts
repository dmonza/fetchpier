/**
 * Characters no portable file or folder name may contain: path separators, the
 * punctuation Windows reserves, and control characters. Shared with the
 * workspace's name check for names the user types (`assertPortableName`).
 */
// eslint-disable-next-line no-control-regex
export const PORTABLE_NAME_INVALID_CHAR = /[/\\?*:|"<>\x00-\x1f]/

// Imported names also drop `%` (schema names often carry percent-encoding).
const INVALID_CHARS = new RegExp(`[%${PORTABLE_NAME_INVALID_CHAR.source.slice(1)}`, 'g')
const MAX_NAME_LENGTH = 120

/** Windows device names, reserved with or without an extension (`CON`, `nul.txt`). */
export const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

export function sanitizeName(raw: string, fallback = 'untitled'): string {
  let name = (raw || '').replace(INVALID_CHARS, '-').trim()
  name = name
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    // One dash per edge is all that can remain after the collapse above, and
    // matching a run here would be quadratic on hostile schema names.
    .replace(/^-|-$/g, '')
  if (!name) name = fallback
  // Reject pure-dot segments (`.`, `..`, `...`) — they survive the regex above
  // and would traverse upward when used as a path segment.
  if (/^\.+$/.test(name)) name = fallback
  if (WINDOWS_RESERVED.has(name.toUpperCase())) name = `${name}-file`
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH)
  return name
}

export function sanitizeSegments(segments: string[]): string[] {
  return segments.map((s) => sanitizeName(s, '')).filter((s) => s !== '')
}

export function uniqueName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired)
    return desired
  }
  let i = 2
  while (used.has(`${desired}-${i}`)) i++
  const out = `${desired}-${i}`
  used.add(out)
  return out
}
