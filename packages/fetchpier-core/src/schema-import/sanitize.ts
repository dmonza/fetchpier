// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[/\\?%*:|"<>\x00-\x1f]/g
const MAX_NAME_LENGTH = 120

const WINDOWS_RESERVED = new Set([
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
    .replace(/^-+|-+$/g, '')
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
